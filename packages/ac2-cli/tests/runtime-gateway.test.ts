/**
 * Tests for the `openclaw-gateway` runtime adapter and its supporting
 * modules (`src/runtime/gateway/*`). Everything here runs against a
 * {@link FakeGatewayConnection} — no real WebSocket, and no real gateway
 * process — see `tests/helpers/gateway-connection.ts`.
 */

import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Ac2RuntimeHost, Ac2RuntimeInbound } from '@algorandfoundation/ac2-sdk/runtime';
import { InMemoryChannelProvider } from '@algorandfoundation/ac2-sdk/providers/in-memory';
import { createGatewayClient, missingScopes } from '../src/runtime/gateway/client.js';
import {
  buildDeviceAuthPayloadV3,
  createServiceKeyDeviceIdentity,
  deviceIdFromPublicKeyRaw,
  type GatewayDeviceIdentity,
} from '../src/runtime/gateway/device-identity.js';
import { createServiceKeystoreAccess } from '../src/identity/service-key.js';
import { publicKeyToDidKey } from '../src/identity/did.js';
import { createOpenClawGatewayAdapter, mapHistoryMessages } from '../src/runtime/gateway/adapter.js';
import { resolveGatewayConfig } from '../src/runtime/gateway/config.js';
import { AC2_STREAM_CONTROL_PREFIX } from '../src/runtime/gateway/wallet-frames.js';
import { DEFAULT_RUNTIME_ADAPTER, loadRuntimeAdapter } from '../src/runtime/loader.js';
import { runDaemon, type RunningDaemon } from '../src/daemon/run.js';
import { connectControl, type ControlClient } from '../src/control/client.js';
import { FakeGatewayConnection, waitFor } from './helpers/gateway-connection.js';
import { createKeyStoreFixture } from './helpers/keystore.js';

const ORIGIN = 'https://debug.liquidauth.com';

/**
 * Daemon state (keystore metadata included) is written under the state dir, so
 * the whole file runs against a throwaway one — no test may ever touch the
 * developer's real `~/.openclaw`.
 */
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), 'ac2-gateway-test-state-'));
let previousTestStateDir: string | undefined;

beforeAll(() => {
  previousTestStateDir = process.env['AC2_STATE_DIR'];
  process.env['AC2_STATE_DIR'] = TEST_STATE_DIR;
});

afterAll(async () => {
  if (previousTestStateDir === undefined) delete process.env['AC2_STATE_DIR'];
  else process.env['AC2_STATE_DIR'] = previousTestStateDir;
  await rm(TEST_STATE_DIR, { recursive: true, force: true });
});

/** Parse an `ac2-stream` control frame back into its JSON body. */
function parseStreamFrame(raw: string): Record<string, unknown> {
  expect(raw[0]).toBe(AC2_STREAM_CONTROL_PREFIX);
  return JSON.parse(raw.slice(1)) as Record<string, unknown>;
}

interface RecordedSend {
  payload: string;
  channel: 'control' | 'stream';
}

/** A minimal fake {@link Ac2RuntimeHost} that records every outbound send. */
function createFakeHost(): { host: Ac2RuntimeHost; sends: RecordedSend[]; logs: string[] } {
  const sends: RecordedSend[] = [];
  const logs: string[] = [];
  const host: Ac2RuntimeHost = {
    agent: 'openclaw',
    serviceDid: null,
    log: (line: string): void => {
      logs.push(line);
    },
    send: async (payload: string, channel: 'control' | 'stream' = 'control'): Promise<boolean> => {
      sends.push({ payload, channel });
      return true;
    },
  };
  return { host, sends, logs };
}

describe('Gateway RPC client (client.ts)', () => {
  it('resolves ready once hello-ok arrives, sending the documented connect envelope first', async () => {
    const connection = new FakeGatewayConnection();
    const client = createGatewayClient({ connection, log: () => {} });

    connection.triggerOpen();
    expect(connection.sent).toHaveLength(1);
    expect(connection.sent[0]).toMatchObject({ type: 'req', method: 'connect' });
    const params = connection.sent[0]?.params as Record<string, unknown>;
    expect(params).toMatchObject({
      minProtocol: 4,
      maxProtocol: 4,
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
    });
    expect((params['client'] as Record<string, unknown>)['id']).toBe('cli');
    expect((params['client'] as Record<string, unknown>)['mode']).toBe('cli');
    expect(params).not.toHaveProperty('auth');

    await connection.emitHelloOk();
    await expect(client.ready).resolves.toBeUndefined();
  });

  it('sends auth.token only when a token is configured', async () => {
    const connection = new FakeGatewayConnection();
    createGatewayClient({ connection, log: () => {}, token: 'secret-token' });
    connection.triggerOpen();
    const params = connection.sent[0]?.params as Record<string, unknown>;
    expect(params['auth']).toEqual({ token: 'secret-token' });
  });

  // The gateway only BINDS the requested scopes to a signed device identity;
  // an unsigned connect is accepted and then stripped of them, which is what
  // produced `missing scope: operator.read` on every later RPC. So with an
  // identity configured the connect must wait for the challenge nonce and
  // answer it with a signature the gateway can verify.
  describe('device identity handshake', () => {
    /**
     * The identity is the daemon's own service key, reached through the same
     * keystore capability `daemon/run.ts` hands its built-in adapters. Backed
     * by the REAL keystore engine over in-memory seams, so these exercise the
     * actual (async, non-extractable) signing path.
     */
    function identityFor(): {
      identity: GatewayDeviceIdentity;
      publicKeyRaw: () => Promise<Uint8Array>;
    } {
      const keystore = createServiceKeystoreAccess(createKeyStoreFixture().create());
      return {
        identity: createServiceKeyDeviceIdentity(keystore),
        publicKeyRaw: () => keystore.servicePublicKey(),
      };
    }

    it('holds the connect back until connect.challenge, then signs the nonce', async () => {
      const { identity: deviceIdentity, publicKeyRaw } = identityFor();
      const connection = new FakeGatewayConnection();
      const client = createGatewayClient({
        connection,
        log: () => {},
        token: 'secret-token',
        deviceIdentity,
      });

      connection.triggerOpen();
      // Nothing may go out before the nonce exists — the signature covers it.
      expect(connection.sent).toHaveLength(0);

      connection.emitEvent('connect.challenge', { nonce: 'nonce-123', ts: 1 });
      // Signing goes through the keystore, so the frame lands asynchronously.
      await waitFor(() => connection.sent.length === 1);

      const publicKey = await publicKeyRaw();
      const deviceId = deviceIdFromPublicKeyRaw(publicKey);
      const params = connection.sent[0]?.params as Record<string, unknown>;
      const device = params['device'] as Record<string, unknown>;
      expect(device['id']).toBe(deviceId);
      expect(device['publicKey']).toBe(Buffer.from(publicKey).toString('base64url'));
      expect(device['nonce']).toBe('nonce-123');

      // Verify the signature exactly as the gateway does: rebuild the v3
      // payload from the frame and check it against the raw public key.
      const payload = buildDeviceAuthPayloadV3({
        deviceId,
        clientId: 'cli',
        clientMode: 'cli',
        role: 'operator',
        scopes: params['scopes'] as string[],
        signedAtMs: device['signedAt'] as number,
        token: 'secret-token',
        nonce: 'nonce-123',
        platform: process.platform,
      });
      const verified = verify(
        null,
        Buffer.from(payload, 'utf8'),
        createPublicKey({
          key: Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'),
            Buffer.from(publicKey),
          ]),
          format: 'der',
          type: 'spki',
        }),
        Buffer.from(device['signature'] as string, 'base64url'),
      );
      expect(verified).toBe(true);

      connection.respondOk('connect', {
        type: 'hello-ok',
        protocol: 4,
        auth: { role: 'operator', scopes: ['operator.read', 'operator.write'] },
      });
      await expect(client.ready).resolves.toBeUndefined();
      expect(client.grantedScopes).toEqual(['operator.read', 'operator.write']);
    });

    // The regression itself: `ok:true` with no usable scopes is a FAILED
    // handshake, not a connected gateway whose every call happens to 403.
    it('rejects ready when hello-ok grants no usable scopes', async () => {
      const connection = new FakeGatewayConnection();
      const client = createGatewayClient({ connection, log: () => {}, token: 'secret-token' });
      connection.triggerOpen();
      await connection.emitHelloOk({ role: 'operator', scopes: [] });
      await expect(client.ready).rejects.toThrow(/operator\.read, operator\.write is required/);
    });

    it('rejects ready when only some required scopes are granted', async () => {
      const connection = new FakeGatewayConnection();
      const client = createGatewayClient({ connection, log: () => {} });
      connection.triggerOpen();
      await connection.emitHelloOk({ role: 'operator', scopes: ['operator.read'] });
      await expect(client.ready).rejects.toThrow(/operator\.write is required/);
    });

    it('accepts operator.admin as covering every required scope', async () => {
      const connection = new FakeGatewayConnection();
      const client = createGatewayClient({ connection, log: () => {} });
      connection.triggerOpen();
      await connection.emitHelloOk({ role: 'operator', scopes: ['operator.admin'] });
      await expect(client.ready).resolves.toBeUndefined();
    });

    it('reports an issued device token and replays it as auth.deviceToken', async () => {
      const { identity: deviceIdentity } = identityFor();
      const issued: Array<{ token: string; scopes: string[] | undefined }> = [];

      const first = new FakeGatewayConnection();
      const firstClient = createGatewayClient({
        connection: first,
        log: () => {},
        deviceIdentity,
        onDeviceToken: (token, scopes) => issued.push({ token, scopes }),
      });
      first.triggerOpen();
      await first.emitHelloOk({ scopes: ['operator.read', 'operator.write'], deviceToken: 'dt-1' });
      await expect(firstClient.ready).resolves.toBeUndefined();
      expect(issued).toEqual([{ token: 'dt-1', scopes: ['operator.read', 'operator.write'] }]);

      const second = new FakeGatewayConnection();
      createGatewayClient({ connection: second, log: () => {}, deviceIdentity, deviceToken: 'dt-1' });
      second.triggerOpen();
      second.emitEvent('connect.challenge', { nonce: 'n2' });
      await waitFor(() => second.sent.length === 1);
      const params = second.sent[0]?.params as Record<string, unknown>;
      expect(params['auth']).toEqual({ deviceToken: 'dt-1' });
    });

    it('falls back to an unsigned connect when the gateway never challenges', async () => {
      vi.useFakeTimers();
      try {
        const connection = new FakeGatewayConnection();
        createGatewayClient({
          connection,
          log: () => {},
          deviceIdentity: identityFor().identity,
        });
        connection.triggerOpen();
        expect(connection.sent).toHaveLength(0);
        vi.advanceTimersByTime(2000);
        expect(connection.sent).toHaveLength(1);
        expect(connection.sent[0]?.params).not.toHaveProperty('device');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('missingScopes', () => {
    it('treats operator.admin as a superset and operator.write as covering reads', () => {
      expect(missingScopes(['operator.admin'], ['operator.read', 'operator.write'])).toEqual([]);
      expect(missingScopes(['operator.write'], ['operator.read'])).toEqual([]);
      expect(missingScopes(['operator.read'], ['operator.write'])).toEqual(['operator.write']);
      expect(missingScopes([], ['operator.read'])).toEqual(['operator.read']);
    });
  });

  // Regression for the live-validation finding: the real Gateway does NOT send
  // a top-level `hello-ok` frame — it answers the `connect` request with a
  // `res` whose `payload` is the hello-ok (preceded by a `connect.challenge`
  // event). An earlier client only resolved on a top-level `hello-ok`, so a
  // successful token handshake hung until it timed out.
  it('resolves ready when hello-ok is delivered as the connect response payload', async () => {
    const connection = new FakeGatewayConnection();
    const client = createGatewayClient({ connection, log: () => {} });
    connection.triggerOpen();
    connection.emitEvent('connect.challenge', { nonce: 'n', ts: 1 });
    connection.respondOk('connect', {
      type: 'hello-ok',
      protocol: 4,
      server: { version: 'x', connId: 'c' },
    });
    await expect(client.ready).resolves.toBeUndefined();
  });

  // Regression: a rejected connect (e.g. no/invalid token →
  // NOT_PAIRED/DEVICE_IDENTITY_REQUIRED) arrives as a `res` with `ok:false`
  // correlated to the connect id, and must reject `ready` (not hang).
  it('rejects ready when the connect response is ok:false', async () => {
    const connection = new FakeGatewayConnection();
    const client = createGatewayClient({ connection, log: () => {} });
    connection.triggerOpen();
    connection.respondError('connect', {
      code: 'NOT_PAIRED',
      message: 'device identity required',
    });
    await expect(client.ready).rejects.toThrow(/device identity required/);
  });

  it('correlates request/response by id and resolves the payload', async () => {
    const connection = new FakeGatewayConnection();
    const client = createGatewayClient({ connection, log: () => {} });
    connection.triggerOpen();
    await connection.emitHelloOk();
    await client.ready;

    const promise = client.request('example.method', { a: 1 });
    await waitFor(() => connection.sent.some((f) => f.method === 'example.method'));
    connection.respondOk('example.method', { bar: 1 });
    await expect(promise).resolves.toEqual({ bar: 1 });
  });

  it('rejects with the gateway error code/message on ok:false', async () => {
    const connection = new FakeGatewayConnection();
    const client = createGatewayClient({ connection, log: () => {} });
    connection.triggerOpen();
    await connection.emitHelloOk();
    await client.ready;

    const promise = client.request('example.method', {});
    await waitFor(() => connection.sent.some((f) => f.method === 'example.method'));
    connection.respondError('example.method', { code: 'bad_request', message: 'nope' });
    await expect(promise).rejects.toMatchObject({ code: 'bad_request', message: 'nope' });
  });

  it('rejects a request that times out', async () => {
    const connection = new FakeGatewayConnection();
    const client = createGatewayClient({ connection, log: () => {} });
    connection.triggerOpen();
    await connection.emitHelloOk();
    await client.ready;

    await expect(client.request('example.slow', {}, 20)).rejects.toThrow(/timed out/);
  });

  it('dispatches event frames through onEvent', async () => {
    const connection = new FakeGatewayConnection();
    const client = createGatewayClient({ connection, log: () => {} });
    connection.triggerOpen();
    await connection.emitHelloOk();
    await client.ready;

    const received: Array<{ event: string; payload: unknown }> = [];
    client.onEvent((event, payload) => received.push({ event, payload }));
    connection.emitEvent('chat', { deltaText: 'hi' });
    expect(received).toEqual([{ event: 'chat', payload: { deltaText: 'hi' } }]);
  });
});

describe('resolveGatewayConfig (config.ts)', () => {
  // A reader that reports "no openclaw.json here", so these precedence tests
  // are isolated from the real `~/.openclaw` on the machine running the suite.
  const noDiscovery = () => undefined;

  it('defaults to the local gateway with no token/agentId configured', () => {
    const cfg = resolveGatewayConfig({}, {}, () => {}, noDiscovery);
    expect(cfg.url).toBe('ws://127.0.0.1:18789');
    expect(cfg.token).toBeUndefined();
    expect(cfg.agentId).toBeUndefined();
    expect(cfg.connectTimeoutMs).toBe(10000);
    // Deliberately above the 120s an x402 wallet signature is allowed to take,
    // so a turn blocked on human approval is not failed as "did not respond".
    expect(cfg.runTimeoutMs).toBe(300000);
  });

  it('prefers explicit config over env, and env over the default', () => {
    const cfg = resolveGatewayConfig(
      { url: 'ws://config-wins:1' },
      { OPENCLAW_GATEWAY_URL: 'ws://env-wins:2', OPENCLAW_GATEWAY_PORT: '9999' },
      () => {},
      noDiscovery,
    );
    expect(cfg.url).toBe('ws://config-wins:1');

    const cfgEnv = resolveGatewayConfig(
      {},
      { OPENCLAW_GATEWAY_URL: 'ws://env-wins:2' },
      () => {},
      noDiscovery,
    );
    expect(cfgEnv.url).toBe('ws://env-wins:2');

    const cfgPort = resolveGatewayConfig(
      {},
      { OPENCLAW_GATEWAY_PORT: '9999' },
      () => {},
      noDiscovery,
    );
    expect(cfgPort.url).toBe('ws://127.0.0.1:9999');
  });

  it('reads the token and agentId from config/env', () => {
    const cfg = resolveGatewayConfig({ token: 'tok', agentId: 'agent-x' }, {}, () => {}, noDiscovery);
    expect(cfg.token).toBe('tok');
    expect(cfg.agentId).toBe('agent-x');

    const cfgEnv = resolveGatewayConfig(
      {},
      { OPENCLAW_GATEWAY_TOKEN: 'env-tok' },
      () => {},
      noDiscovery,
    );
    expect(cfgEnv.token).toBe('env-tok');
  });

  it('ignores malformed values with a logged note instead of throwing', () => {
    const logs: string[] = [];
    const cfg = resolveGatewayConfig(
      { url: 42, connectTimeoutMs: 'nope' },
      {},
      (line) => logs.push(line),
      noDiscovery,
    );
    expect(cfg.url).toBe('ws://127.0.0.1:18789');
    expect(cfg.connectTimeoutMs).toBe(10000);
    expect(logs.length).toBeGreaterThan(0);
  });

  describe('openclaw.json auto-discovery (lowest priority)', () => {
    // A minimal token-guarded local gateway, as OpenClaw writes it.
    const openClawJson = JSON.stringify({
      gateway: { port: 4242, bind: 'loopback', auth: { mode: 'token', token: 'discovered-token' } },
    });

    it('discovers the token and port from openclaw.json when config/env are empty', () => {
      const logs: string[] = [];
      const cfg = resolveGatewayConfig({}, {}, (l) => logs.push(l), () => openClawJson);
      expect(cfg.token).toBe('discovered-token');
      expect(cfg.url).toBe('ws://127.0.0.1:4242');
      expect(logs.some((l) => l.includes('discovered from openclaw.json'))).toBe(true);
    });

    it('resolves openclaw.json from OPENCLAW_CONFIG_PATH (mirroring the plugin path logic)', () => {
      const seen: string[] = [];
      const reader = (path: string) => {
        seen.push(path);
        return openClawJson;
      };
      const cfg = resolveGatewayConfig({}, { OPENCLAW_CONFIG_PATH: '/custom/openclaw.json' }, () => {}, reader);
      expect(seen).toContain('/custom/openclaw.json');
      expect(cfg.token).toBe('discovered-token');
    });

    it('lets explicit config and env override discovery', () => {
      const configWins = resolveGatewayConfig(
        { token: 'config-token', url: 'ws://config:1' },
        {},
        () => {},
        () => openClawJson,
      );
      expect(configWins.token).toBe('config-token');
      expect(configWins.url).toBe('ws://config:1');

      const envWins = resolveGatewayConfig(
        {},
        { OPENCLAW_GATEWAY_TOKEN: 'env-token', OPENCLAW_GATEWAY_PORT: '5555' },
        () => {},
        () => openClawJson,
      );
      expect(envWins.token).toBe('env-token');
      expect(envWins.url).toBe('ws://127.0.0.1:5555');
    });

    it('does not read openclaw.json at all when both token and url are already resolved', () => {
      let reads = 0;
      const reader = () => {
        reads += 1;
        return openClawJson;
      };
      resolveGatewayConfig(
        { token: 'config-token', url: 'ws://config:1' },
        {},
        () => {},
        reader,
      );
      expect(reads).toBe(0);
    });

    it('never lifts a token when gateway.auth.mode is not "token"', () => {
      const passwordMode = JSON.stringify({
        gateway: { port: 4242, auth: { mode: 'password', token: 'should-be-ignored' } },
      });
      const cfg = resolveGatewayConfig({}, {}, () => {}, () => passwordMode);
      expect(cfg.token).toBeUndefined();
      // The port is still discovered — only the token is gated by auth.mode.
      expect(cfg.url).toBe('ws://127.0.0.1:4242');
    });

    // Token auth is the gateway's DEFAULT: a config that only sets
    // `gateway.auth.token` (no `mode`) is still token-guarded, and skipping
    // the token there left the daemon connecting unauthenticated — which the
    // gateway answers by granting it no operator scopes at all.
    it('lifts the token when gateway.auth.mode is absent (token is the default mode)', () => {
      const noMode = JSON.stringify({ gateway: { port: 4242, auth: { token: 'default-mode-token' } } });
      const cfg = resolveGatewayConfig({}, {}, () => {}, () => noMode);
      expect(cfg.token).toBe('default-mode-token');
    });

    it('falls back to gateway.remote.token when gateway.auth.token is unset', () => {
      const remoteOnly = JSON.stringify({ gateway: { port: 4242, remote: { token: 'remote-token' } } });
      const cfg = resolveGatewayConfig({}, {}, () => {}, () => remoteOnly);
      expect(cfg.token).toBe('remote-token');
    });

    it('degrades gracefully when openclaw.json is absent or malformed', () => {
      const absent = resolveGatewayConfig({}, {}, () => {}, () => undefined);
      expect(absent.token).toBeUndefined();
      expect(absent.url).toBe('ws://127.0.0.1:18789');

      const logs: string[] = [];
      const malformed = resolveGatewayConfig({}, {}, (l) => logs.push(l), () => '{not json');
      expect(malformed.token).toBeUndefined();
      expect(malformed.url).toBe('ws://127.0.0.1:18789');
      expect(logs.some((l) => l.includes('not valid JSON'))).toBe(true);
    });
  });
});

describe('createOpenClawGatewayAdapter (adapter.ts)', () => {
  const CONTROLLER_DID = 'did:key:zTest';

  /** Build an adapter wired to a fresh {@link FakeGatewayConnection}, connected and ready. */
  async function setup(): Promise<{
    host: Ac2RuntimeHost;
    sends: RecordedSend[];
    logs: string[];
    connection: FakeGatewayConnection;
    adapter: ReturnType<typeof createOpenClawGatewayAdapter>;
  }> {
    const { host, sends, logs } = createFakeHost();
    let connection!: FakeGatewayConnection;
    const adapter = createOpenClawGatewayAdapter(host, {
      __connectionFactory: () => {
        connection = new FakeGatewayConnection();
        return connection;
      },
      // Keep the adapter hermetic: never read the host's real `~/.openclaw`
      // during the suite (otherwise token/port discovery would leak the
      // machine's actual gateway settings into these assertions).
      __readOpenClawConfigFile: () => undefined,
    });
    await adapter.start?.();
    connection.triggerOpen();
    await connection.emitHelloOk();
    await waitFor(() => logs.some((line) => line.includes('gateway connected')));
    return { host, sends, logs, connection, adapter };
  }

  function inboundMessage(payload: string, controllerDid: string | null = CONTROLLER_DID): Ac2RuntimeInbound {
    return { channel: 'control', payload, controllerDid, requestId: 'req-1' };
  }

  it('emits a preview(thinking) frame immediately, then an agent request with no agentId', async () => {
    const { sends, connection, adapter } = await setup();

    const handled = adapter.handleInbound(inboundMessage('hello there'));

    await waitFor(() => sends.length > 0);
    expect(parseStreamFrame(sends[0]!.payload)).toMatchObject({
      t: 'preview',
      phase: 'thinking',
      thid: 'default',
    });

    await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
    const subscribeReq = connection.sent.find((f) => f.method === 'sessions.messages.subscribe');
    expect(subscribeReq?.params).toEqual({ key: 'ac2:did:key:zTest' });
    connection.respondOk('sessions.messages.subscribe', {});

    await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
    const agentReq = connection.sent.find((f) => f.method === 'agent');
    const agentParams = agentReq?.params as Record<string, unknown>;
    expect(agentParams).toMatchObject({
      message: 'hello there',
      sessionKey: 'ac2:did:key:zTest',
      deliver: false,
    });
    expect(agentParams).not.toHaveProperty('agentId');
    expect(typeof agentParams['idempotencyKey']).toBe('string');
    connection.respondOk('agent', { runId: 'run-1', acceptedAt: Date.now() });

    await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));
    connection.respondOk('agent.wait', { status: 'ok' });

    // No stream text was produced, so the adapter reads the final text back
    // from chat.history. Empty here → nothing to say, so it CLEARS the live
    // indicator rather than inventing a bubble (a turn can legitimately commit
    // no assistant text, e.g. it only delegated to a sub-agent and yielded).
    await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
    connection.respondOk('chat.history', { messages: [] });

    await handled;
    const finalize = parseStreamFrame(sends[sends.length - 1]!.payload);
    expect(finalize).toMatchObject({ t: 'discard', thid: 'default' });
  });

  it('lets a slow turn run past the client RPC default instead of failing it at 30s', async () => {
    // Regression: the foreground `agent.wait` omitted its client-side timeout,
    // so the RPC's 30s default fired long before the 5-minute server deadline
    // it had just asked for. An x402 payment blocks on a wallet signature
    // round-trip (itself allowed 120s), so every one of them was reported to
    // the user as "the agent ran into an error" — while the run, which cannot
    // be cancelled, kept going and often succeeded.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { sends, logs, connection, adapter } = await setup();

      const handled = adapter.handleInbound(inboundMessage('pay the invoice'));
      await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
      connection.respondOk('sessions.messages.subscribe', {});
      await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
      connection.respondOk('agent', { runId: 'run-slow', acceptedAt: Date.now() });
      await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));

      // Well past the client default, still inside the deadline we asked for.
      await vi.advanceTimersByTimeAsync(60_000);
      // (Only the wait matters here: the harness never answers the optional
      // `sessions.subscribe`, whose own best-effort timeout is expected.)
      expect(logs.filter((line) => line.includes('"agent.wait" timed out'))).toEqual([]);
      expect(sends.some((s) => parseStreamFrame(s.payload)['t'] === 'finalize')).toBe(false);

      // The signature finally lands and the turn completes normally.
      connection.respondOk('agent.wait', { status: 'ok' });
      await vi.advanceTimersByTimeAsync(1_000);
      await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
      connection.respondOk('chat.history', { messages: [] });
      await handled;
      expect(logs.some((line) => line.includes('agent run failed'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never re-posts a STALE chat.history message as this run\'s reply', async () => {
    const { sends, connection, adapter } = await setup();

    const handled = adapter.handleInbound(inboundMessage('spawn something'));
    await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
    connection.respondOk('sessions.messages.subscribe', {});
    await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
    connection.respondOk('agent', { runId: 'run-stale', acceptedAt: Date.now() });
    await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));
    connection.respondOk('agent.wait', { status: 'ok' });

    // The transcript's newest assistant message predates this run — it is the
    // PREVIOUS turn's answer. Re-finalizing it duplicated the old reply in the
    // wallet (seen live), so it must be rejected.
    await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
    connection.respondOk('chat.history', {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'an answer from an earlier turn' }],
          timestamp: Date.now() - 600_000,
          __openclaw: { recordTimestampMs: Date.now() - 600_000 },
        },
      ],
    });

    await handled;
    const staleEcho = sends.some((s) => {
      const f = parseStreamFrame(s.payload);
      return f['t'] === 'finalize' && f['text'] === 'an answer from an earlier turn';
    });
    expect(staleEcho).toBe(false);
    expect(parseStreamFrame(sends[sends.length - 1]!.payload)).toMatchObject({ t: 'discard' });
  });

  it('translates a streamed assistant delta into a preview(typing) frame, then finalizes with it', async () => {
    const { sends, connection, adapter } = await setup();

    const handled = adapter.handleInbound(inboundMessage('what is the weather'));

    await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
    connection.respondOk('sessions.messages.subscribe', {});
    await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
    connection.respondOk('agent', { runId: 'run-2', acceptedAt: Date.now() });

    await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));
    connection.emitEvent('chat', { deltaText: 'It is sunny.' });

    await waitFor(() =>
      sends.some((s) => {
        const frame = parseStreamFrame(s.payload);
        return frame['t'] === 'preview' && frame['phase'] === 'typing' && frame['text'] === 'It is sunny.';
      }),
    );

    connection.respondOk('agent.wait', { status: 'ok' });
    await handled;

    const finalize = parseStreamFrame(sends[sends.length - 1]!.payload);
    expect(finalize).toMatchObject({ t: 'finalize', thid: 'default', text: 'It is sunny.' });
    expect(typeof finalize['mid']).toBe('string');
  });

  it('commits the assistant\'s session.message as its own bubble and never the user\'s (live-validation guard)', async () => {
    const { sends, connection, adapter } = await setup();

    const handled = adapter.handleInbound(inboundMessage('ping'));
    await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
    connection.respondOk('sessions.messages.subscribe', {});
    await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
    connection.respondOk('agent', { runId: 'run-echo', acceptedAt: Date.now() });
    await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));

    // The gateway mirrors the USER's own turn as a `session.message` (confirmed
    // live: role 'user', plain-string content). It must NOT be committed back
    // as an agent bubble. The assistant's committed turn becomes its own
    // finalized wallet message (keyed by the gateway `messageId`).
    connection.emitEvent('session.message', {
      sessionKey: 'ac2:did:key:zTest',
      messageId: 'm-user',
      message: { role: 'user', content: 'ping' },
    });
    connection.emitEvent('session.message', {
      sessionKey: 'ac2:did:key:zTest',
      messageId: 'm-asst',
      message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] },
    });

    await waitFor(() =>
      sends.some((s) => {
        const f = parseStreamFrame(s.payload);
        return f['t'] === 'finalize' && f['text'] === 'pong' && f['mid'] === 'm-asst';
      }),
    );
    // The user's own text is never surfaced as an agent message (finalize or preview).
    const echoedUser = sends.some((s) => {
      const f = parseStreamFrame(s.payload);
      return f['text'] === 'ping';
    });
    expect(echoedUser).toBe(false);

    connection.respondOk('agent.wait', { status: 'ok' });
    await handled;
  });

  it('splits one turn into a wallet message per committed assistant segment (intro then reply around a tool)', async () => {
    const { sends, connection, adapter } = await setup();

    const handled = adapter.handleInbound(inboundMessage('go'));
    await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
    connection.respondOk('sessions.messages.subscribe', {});
    await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
    // The gateway resolves a CANONICAL session key and returns it; the adapter
    // must adopt it so `session.message` events (which carry no runId) correlate.
    const CANON = 'agent:main:ac2:did:key:zTest';
    connection.respondOk('agent', { runId: 'run-split', sessionKey: CANON, acceptedAt: Date.now() });
    await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));

    // Segment 1 streams (chat is correlated by runId), then commits.
    connection.emitEvent('chat', { runId: 'run-split', deltaText: 'Hello there.' });
    connection.emitEvent('session.message', {
      sessionKey: CANON,
      messageId: 'seg-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }] },
    });
    await waitFor(() =>
      sends.some((s) => {
        const f = parseStreamFrame(s.payload);
        return f['t'] === 'finalize' && f['mid'] === 'seg-1' && f['text'] === 'Hello there.';
      }),
    );

    // Dedup: the same committed message must not finalize twice.
    connection.emitEvent('session.message', {
      sessionKey: CANON,
      messageId: 'seg-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }] },
    });

    // Segment 2 arrives after a tool call. `chat` stays run-CUMULATIVE, so the
    // live typing preview must show only the uncommitted tail ("The reply."),
    // not the whole "Hello there.The reply.".
    connection.emitEvent('chat', {
      runId: 'run-split',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there.The reply.' }] },
    });
    await waitFor(() =>
      sends.some((s) => {
        const f = parseStreamFrame(s.payload);
        return f['t'] === 'preview' && f['phase'] === 'typing' && f['text'] === 'The reply.';
      }),
    );
    connection.emitEvent('session.message', {
      sessionKey: CANON,
      messageId: 'seg-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The reply.' }] },
    });
    await waitFor(() =>
      sends.some((s) => {
        const f = parseStreamFrame(s.payload);
        return f['t'] === 'finalize' && f['mid'] === 'seg-2' && f['text'] === 'The reply.';
      }),
    );

    connection.respondOk('agent.wait', { status: 'ok' });
    await handled;

    // Exactly two finalized bubbles, in order, each carrying only its own
    // segment — never one merged bubble, and never a duplicate seg-1.
    const finalizes = sends
      .map((s) => parseStreamFrame(s.payload))
      .filter((f) => f['t'] === 'finalize');
    expect(finalizes.map((f) => f['text'])).toEqual(['Hello there.', 'The reply.']);
    // The live preview never re-showed the already-committed intro text.
    const previewShowedMerged = sends.some((s) => {
      const f = parseStreamFrame(s.payload);
      return f['t'] === 'preview' && f['text'] === 'Hello there.The reply.';
    });
    expect(previewShowedMerged).toBe(false);
  });

  it('emits an agent_error notice and finalizes with an error message when agent.wait reports an error', async () => {
    const { sends, connection, adapter } = await setup();

    const handled = adapter.handleInbound(inboundMessage('do something'));

    await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
    connection.respondOk('sessions.messages.subscribe', {});
    await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
    connection.respondOk('agent', { runId: 'run-3', acceptedAt: Date.now() });

    await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));
    connection.respondOk('agent.wait', { status: 'error', error: { message: 'boom' } });

    await handled;

    const notice = sends.find((s) => parseStreamFrame(s.payload)['t'] === 'notice');
    expect(notice).toBeDefined();
    expect(parseStreamFrame(notice!.payload)).toMatchObject({ code: 'agent_error', level: 'error' });

    const finalize = parseStreamFrame(sends[sends.length - 1]!.payload);
    expect(finalize['t']).toBe('finalize');
  });

  it('uses sessionKey ac2:<did>:<thid> for an explicit thid in a JSON inbound frame', async () => {
    const { connection, adapter } = await setup();

    const handled = adapter.handleInbound(
      inboundMessage(JSON.stringify({ thid: 'thread-42', body: { content: 'hi there' } })),
    );

    await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
    const subscribeReq = connection.sent.find((f) => f.method === 'sessions.messages.subscribe');
    expect(subscribeReq?.params).toEqual({ key: 'ac2:did:key:zTest:thread-42' });
    connection.respondOk('sessions.messages.subscribe', {});

    await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
    const agentReq = connection.sent.find((f) => f.method === 'agent');
    expect((agentReq?.params as Record<string, unknown>)['sessionKey']).toBe('ac2:did:key:zTest:thread-42');
    connection.respondOk('agent', { runId: 'run-4', acceptedAt: Date.now() });

    await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));
    connection.respondOk('agent.wait', { status: 'ok' });
    await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
    connection.respondOk('chat.history', { messages: [] });
    await handled;
  });

  it('ignores an inbound frame with no controllerDid', async () => {
    const { sends, adapter } = await setup();
    await adapter.handleInbound(inboundMessage('hello', null));
    expect(sends).toEqual([]);
  });

  it('host.send still works while onConnected reported a locked connection', async () => {
    const { host, sends, adapter } = await setup();

    await adapter.onConnected?.({
      requestId: 'req-locked',
      controllerDid: null,
      walletAddress: null,
      agentDid: null,
      identityGranted: false,
      locked: true,
    });

    const delivered = await host.send('you are not registered', 'stream');
    expect(delivered).toBe(true);
    expect(sends).toContainEqual({ payload: 'you are not registered', channel: 'stream' });
  });

  it('passes agentId through to the agent RPC when configured', async () => {
    const { host, logs } = createFakeHost();
    let connection!: FakeGatewayConnection;
    const adapter = createOpenClawGatewayAdapter(host, {
      agentId: 'configured-agent',
      __connectionFactory: () => {
        connection = new FakeGatewayConnection();
        return connection;
      },
    });
    await adapter.start?.();
    connection.triggerOpen();
    await connection.emitHelloOk();
    await waitFor(() => logs.some((line) => line.includes('gateway connected')));

    const handled = adapter.handleInbound(inboundMessage('hi'));
    await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
    connection.respondOk('sessions.messages.subscribe', {});
    await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
    const agentReq = connection.sent.find((f) => f.method === 'agent');
    expect((agentReq?.params as Record<string, unknown>)['agentId']).toBe('configured-agent');
    connection.respondOk('agent', { runId: 'run-5', acceptedAt: Date.now() });
    await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));
    connection.respondOk('agent.wait', { status: 'ok' });
    await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
    connection.respondOk('chat.history', { messages: [] });
    await handled;
  });

  it('replays past conversation from chat.history as a history frame on connect', async () => {
    const { sends, connection, adapter } = await setup();

    adapter.onConnected?.({
      requestId: 'req-1',
      controllerDid: CONTROLLER_DID,
      walletAddress: null,
      agentDid: null,
      identityGranted: true,
      locked: false,
    });

    // onConnected also advertises this controller's threads (sessions.list);
    // answer it with an empty result so it never leaves a dangling request.
    await waitFor(() => connection.sent.some((f) => f.method === 'sessions.list'));
    connection.respondOk('sessions.list', { sessions: [] });

    await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
    const historyReq = connection.sent.find((f) => f.method === 'chat.history');
    expect(historyReq?.params).toMatchObject({ sessionKey: 'ac2:did:key:zTest' });

    connection.respondOk('chat.history', {
      sessionKey: 'ac2:did:key:zTest',
      messages: [
        { role: 'user', content: 'hello', recordTimestampMs: 111 },
        { role: 'assistant', content: [{ type: 'text', text: 'hi there' }], recordTimestampMs: 222 },
        // a pure tool-call message with no text is skipped by the mapper
        { role: 'assistant', content: [{ type: 'tool_use', name: 'search' }] },
      ],
    });

    await waitFor(() => sends.some((s) => parseStreamFrame(s.payload)['t'] === 'history'));
    const frame = sends.map((s) => parseStreamFrame(s.payload)).find((f) => f['t'] === 'history')!;
    expect(frame).toMatchObject({ t: 'history', thid: 'default' });
    expect(frame['messages']).toEqual([
      { role: 'user', text: 'hello', at: 111 },
      { role: 'assistant', text: 'hi there', at: 222 },
    ]);
  });

  it('does not replay history for a locked connection', async () => {
    const { sends, connection, adapter } = await setup();

    adapter.onConnected?.({
      requestId: 'req-locked',
      controllerDid: CONTROLLER_DID,
      walletAddress: null,
      agentDid: null,
      identityGranted: false,
      locked: true,
    });

    // Give any (wrongly-issued) chat.history a chance to be sent.
    await new Promise((r) => setTimeout(r, 20));
    expect(connection.sent.some((f) => f.method === 'chat.history')).toBe(false);
    expect(sends.some((s) => parseStreamFrame(s.payload)['t'] === 'history')).toBe(false);
  });

  it('translates a cumulative chat snapshot (message.content) into a typing preview', async () => {
    const { sends, connection, adapter } = await setup();

    const handled = adapter.handleInbound(inboundMessage('hi'));
    await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
    connection.respondOk('sessions.messages.subscribe', {});
    await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
    connection.respondOk('agent', { runId: 'run-snap', acceptedAt: Date.now() });
    await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));

    connection.emitEvent('chat', {
      runId: 'run-snap',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Full answer.' }] },
    });

    await waitFor(() =>
      sends.some((s) => {
        const frame = parseStreamFrame(s.payload);
        return frame['t'] === 'preview' && frame['phase'] === 'typing' && frame['text'] === 'Full answer.';
      }),
    );

    connection.respondOk('agent.wait', { status: 'ok' });
    await handled;
    expect(parseStreamFrame(sends[sends.length - 1]!.payload)).toMatchObject({
      t: 'finalize',
      text: 'Full answer.',
    });
  });

  it('falls back to chat.history for the final text when the stream produced none', async () => {
    const { sends, connection, adapter } = await setup();

    const handled = adapter.handleInbound(inboundMessage('hi'));
    await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
    connection.respondOk('sessions.messages.subscribe', {});
    await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
    connection.respondOk('agent', { runId: 'run-fb', acceptedAt: Date.now() });
    await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));

    // No stream events at all → agent.wait ok carries no text → chat.history fallback.
    connection.respondOk('agent.wait', { status: 'ok' });
    await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
    connection.respondOk('chat.history', {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Recovered final answer.' },
      ],
    });

    await handled;
    expect(parseStreamFrame(sends[sends.length - 1]!.payload)).toMatchObject({
      t: 'finalize',
      text: 'Recovered final answer.',
    });
  });

  describe('active thread tracking (onConversation)', () => {
    /** Open `thid` as the active thread and answer its hydration round-trip (subscribe + history). */
    async function openThread(
      connection: FakeGatewayConnection,
      adapter: ReturnType<typeof createOpenClawGatewayAdapter>,
      thid: string,
    ): Promise<void> {
      const opened = adapter.onConversation?.({ kind: 'open', thid, controllerDid: CONTROLLER_DID });
      await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
      connection.respondOk('sessions.messages.subscribe', {});
      await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
      connection.respondOk('chat.history', { messages: [] });
      await opened;
    }

    it('routes a non-explicit inbound frame to the thread most recently opened via onConversation', async () => {
      const { sends, connection, adapter } = await setup();

      await openThread(connection, adapter, 't1');

      const handled = adapter.handleInbound(inboundMessage('hi again'));
      await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
      const agentReq = connection.sent.find((f) => f.method === 'agent');
      expect((agentReq?.params as Record<string, unknown>)['sessionKey']).toBe('ac2:did:key:zTest:t1');
      connection.respondOk('agent', { runId: 'run-active-thread', acceptedAt: Date.now() });
      await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));
      connection.respondOk('agent.wait', { status: 'ok' });
      // No text streamed/committed → `finalizeRun` reads the final text back
      // from `chat.history`, exactly like the pre-existing non-thread tests.
      // `openThread` already used up the FIRST `chat.history` request (for
      // `t1`'s replay), so this waits for the SECOND one.
      await waitFor(() => connection.sent.filter((f) => f.method === 'chat.history').length === 2);
      connection.respondOk('chat.history', { messages: [] });
      await handled;

      const preview = sends
        .map((s) => parseStreamFrame(s.payload))
        .find((f) => f['t'] === 'preview' && f['phase'] === 'thinking');
      expect(preview).toMatchObject({ thid: 't1' });
    });

    it('reverts to the default thread once the active thread is closed', async () => {
      const { connection, adapter } = await setup();

      await openThread(connection, adapter, 't1');
      await adapter.onConversation?.({ kind: 'close', thid: 't1', controllerDid: CONTROLLER_DID });

      const handled = adapter.handleInbound(inboundMessage('back to default'));
      // The default thread's session key was never subscribed to above (only
      // `t1`'s was), so `handleInbound` issues a FRESH subscribe for it first.
      await waitFor(() => connection.sent.filter((f) => f.method === 'sessions.messages.subscribe').length === 2);
      connection.respondOk('sessions.messages.subscribe', {});
      await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
      const agentReq = connection.sent.find((f) => f.method === 'agent');
      expect((agentReq?.params as Record<string, unknown>)['sessionKey']).toBe('ac2:did:key:zTest');
      connection.respondOk('agent', { runId: 'run-back-default', acceptedAt: Date.now() });
      await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));
      connection.respondOk('agent.wait', { status: 'ok' });
      // See the comment above: `openThread` already used the first `chat.history`.
      await waitFor(() => connection.sent.filter((f) => f.method === 'chat.history').length === 2);
      connection.respondOk('chat.history', { messages: [] });
      await handled;
    });

    it('still honors an explicit thid in the inbound frame over the active thread', async () => {
      const { connection, adapter } = await setup();

      await openThread(connection, adapter, 't1');

      const handled = adapter.handleInbound(
        inboundMessage(JSON.stringify({ thid: 'explicit-thread', body: { content: 'explicit please' } })),
      );
      await waitFor(() => connection.sent.filter((f) => f.method === 'sessions.messages.subscribe').length === 2);
      connection.respondOk('sessions.messages.subscribe', {});
      await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
      const agentReq = connection.sent.find((f) => f.method === 'agent');
      expect((agentReq?.params as Record<string, unknown>)['sessionKey']).toBe(
        'ac2:did:key:zTest:explicit-thread',
      );
      connection.respondOk('agent', { runId: 'run-explicit', acceptedAt: Date.now() });
      await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));
      connection.respondOk('agent.wait', { status: 'ok' });
      // See the comment above: `openThread` already used the first `chat.history`.
      await waitFor(() => connection.sent.filter((f) => f.method === 'chat.history').length === 2);
      connection.respondOk('chat.history', { messages: [] });
      await handled;
    });
  });

  describe('durable tool cards (session.tool)', () => {
    it('emits a start/update/result sequence as one tool card with a stable id, name, command, and merged output', async () => {
      const { sends, connection, adapter } = await setup();

      const handled = adapter.handleInbound(inboundMessage('run a command'));
      await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
      connection.respondOk('sessions.messages.subscribe', {});
      await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
      connection.respondOk('agent', { runId: 'run-tool', acceptedAt: Date.now() });
      await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));

      connection.emitEvent('session.tool', {
        runId: 'run-tool',
        stream: 'tool',
        data: { phase: 'start', name: 'shell', toolCallId: 'call-1', args: { command: ['ls', '-la'] } },
      });
      await waitFor(() => sends.some((s) => parseStreamFrame(s.payload)['t'] === 'tool'));
      const startCard = sends.map((s) => parseStreamFrame(s.payload)).find((f) => f['t'] === 'tool')!;
      // The card id is keyed ONLY by the gateway `toolCallId` (no runId), so a
      // later `chat.history` replay of the same call coalesces with this card.
      expect(startCard).toMatchObject({ id: 'tool-call-1', name: 'shell', command: 'ls -la' });

      connection.emitEvent('session.tool', {
        runId: 'run-tool',
        stream: 'tool',
        data: {
          phase: 'update',
          name: 'shell',
          toolCallId: 'call-1',
          partialResult: { content: [{ type: 'text', text: 'partial output' }] },
        },
      });
      await waitFor(() =>
        sends.some((s) => {
          const f = parseStreamFrame(s.payload);
          return f['t'] === 'tool' && f['output'] === 'partial output';
        }),
      );

      connection.emitEvent('session.tool', {
        runId: 'run-tool',
        stream: 'tool',
        data: {
          phase: 'result',
          name: 'shell',
          toolCallId: 'call-1',
          isError: false,
          result: { content: [{ type: 'text', text: 'partial output, done.' }] },
        },
      });
      await waitFor(() =>
        sends.some((s) => {
          const f = parseStreamFrame(s.payload);
          return f['t'] === 'tool' && f['output'] === 'partial output, done.';
        }),
      );

      connection.respondOk('agent.wait', { status: 'ok' });
      await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
      connection.respondOk('chat.history', { messages: [] });
      await handled;

      const toolFrames = sends.map((s) => parseStreamFrame(s.payload)).filter((f) => f['t'] === 'tool');
      expect(toolFrames.every((f) => f['id'] === 'tool-call-1')).toBe(true);
    });

    it('still emits the tool card when the tool result is an error', async () => {
      const { sends, connection, adapter } = await setup();

      const handled = adapter.handleInbound(inboundMessage('run a failing command'));
      await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
      connection.respondOk('sessions.messages.subscribe', {});
      await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
      connection.respondOk('agent', { runId: 'run-tool-err', acceptedAt: Date.now() });
      await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));

      connection.emitEvent('session.tool', {
        runId: 'run-tool-err',
        stream: 'tool',
        data: {
          phase: 'result',
          name: 'shell',
          toolCallId: 'call-err',
          isError: true,
          result: { content: [{ type: 'text', text: 'boom: command failed' }] },
          toolErrorSummary: 'command failed',
        },
      });
      await waitFor(() => sends.some((s) => parseStreamFrame(s.payload)['t'] === 'tool'));
      const card = sends.map((s) => parseStreamFrame(s.payload)).find((f) => f['t'] === 'tool')!;
      expect(card).toMatchObject({ id: 'tool-call-err', output: 'boom: command failed' });

      connection.respondOk('agent.wait', { status: 'ok' });
      await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
      connection.respondOk('chat.history', { messages: [] });
      await handled;
    });
  });

  describe('sub-agent task cards (sessions_spawn / sessions_yield)', () => {
    it('emits a running task card on spawn acceptance, then completes it once the child answers', async () => {
      const { sends, connection, adapter } = await setup();

      const handled = adapter.handleInbound(inboundMessage('delegate this'));
      await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
      connection.respondOk('sessions.messages.subscribe', {});
      await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
      connection.respondOk('agent', { runId: 'run-spawn', acceptedAt: Date.now() });
      await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));
      // Captured NOW, before the spawn's OWN `agent.wait` (for the child run)
      // is sent below \u2014 two `agent.wait` requests are in flight at once, so
      // each must be answered by its OWN id rather than by method name alone.
      const parentWaitReq = connection.sent.find((f) => f.method === 'agent.wait')!;

      connection.emitEvent('session.tool', {
        runId: 'run-spawn',
        stream: 'tool',
        data: {
          phase: 'start',
          name: 'sessions_spawn',
          toolCallId: 'spawn-1',
          args: { task: 'Summarize the quarterly report', taskName: 'Summarize report' },
        },
      });
      connection.emitEvent('session.tool', {
        runId: 'run-spawn',
        stream: 'tool',
        data: {
          phase: 'result',
          name: 'sessions_spawn',
          toolCallId: 'spawn-1',
          isError: false,
          result: {
            details: {
              status: 'accepted',
              childSessionKey: 'agent:main:subagent:child-1',
              runId: 'child-run-1',
            },
          },
        },
      });

      await waitFor(() => sends.some((s) => parseStreamFrame(s.payload)['t'] === 'task'));
      const running = sends.map((s) => parseStreamFrame(s.payload)).find((f) => f['t'] === 'task')!;
      expect(running).toMatchObject({
        id: 'task-agent:main:subagent:child-1',
        title: 'Summarize report',
        status: 'running',
        prompt: 'Summarize the quarterly report',
      });

      connection.emitFrame({ type: 'res', id: parentWaitReq.id, ok: true, payload: { status: 'ok' } });
      await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
      connection.respondOk('chat.history', { messages: [] });
      await handled;

      await waitFor(() =>
        connection.sent.some((f) => f.method === 'agent.wait' && f.id !== parentWaitReq.id),
      );
      const childWaitReq = connection.sent.find(
        (f) => f.method === 'agent.wait' && f.id !== parentWaitReq.id,
      )!;
      expect((childWaitReq.params as Record<string, unknown>)['runId']).toBe('child-run-1');
      connection.emitFrame({ type: 'res', id: childWaitReq.id, ok: true, payload: { status: 'ok' } });

      await waitFor(() =>
        connection.sent.some(
          (f) =>
            f.method === 'chat.history' &&
            (f.params as Record<string, unknown>)['sessionKey'] === 'agent:main:subagent:child-1',
        ),
      );
      connection.respondOk('chat.history', {
        messages: [
          { role: 'user', content: 'Summarize the quarterly report' },
          { role: 'assistant', content: [{ type: 'text', text: 'Revenue grew 12%.' }] },
        ],
      });

      await waitFor(() =>
        sends.some((s) => {
          const f = parseStreamFrame(s.payload);
          return f['t'] === 'task' && f['status'] === 'completed';
        }),
      );
      const completed = sends
        .map((s) => parseStreamFrame(s.payload))
        .filter((f) => f['t'] === 'task')
        .pop()!;
      expect(completed).toMatchObject({
        id: 'task-agent:main:subagent:child-1',
        status: 'completed',
        result: 'Revenue grew 12%.',
      });
    });

    it('marks the task card failed when agent.wait errors on the child run', async () => {
      const { sends, connection, adapter } = await setup();

      const handled = adapter.handleInbound(inboundMessage('delegate this too'));
      await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
      connection.respondOk('sessions.messages.subscribe', {});
      await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
      connection.respondOk('agent', { runId: 'run-spawn-2', acceptedAt: Date.now() });
      await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));
      // Captured NOW, before the child's OWN `agent.wait` is sent below \u2014 see
      // the sibling "completes it once the child answers" test for why.
      const parentWaitReq = connection.sent.find((f) => f.method === 'agent.wait')!;

      connection.emitEvent('session.tool', {
        runId: 'run-spawn-2',
        stream: 'tool',
        data: { phase: 'start', name: 'sessions_spawn', toolCallId: 'spawn-2', args: { task: 'Do a thing' } },
      });
      connection.emitEvent('session.tool', {
        runId: 'run-spawn-2',
        stream: 'tool',
        data: {
          phase: 'result',
          name: 'sessions_spawn',
          toolCallId: 'spawn-2',
          isError: false,
          result: {
            details: { status: 'accepted', childSessionKey: 'agent:main:subagent:child-2', runId: 'child-run-2' },
          },
        },
      });
      await waitFor(() => sends.some((s) => parseStreamFrame(s.payload)['t'] === 'task'));

      connection.emitFrame({ type: 'res', id: parentWaitReq.id, ok: true, payload: { status: 'ok' } });
      await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
      connection.respondOk('chat.history', { messages: [] });
      await handled;

      await waitFor(() =>
        connection.sent.some((f) => f.method === 'agent.wait' && f.id !== parentWaitReq.id),
      );
      const childWaitReq = connection.sent.find(
        (f) => f.method === 'agent.wait' && f.id !== parentWaitReq.id,
      )!;
      expect((childWaitReq.params as Record<string, unknown>)['runId']).toBe('child-run-2');
      connection.emitFrame({
        type: 'res',
        id: childWaitReq.id,
        ok: true,
        payload: { status: 'error', error: { message: 'child crashed' } },
      });

      await waitFor(() =>
        sends.some((s) => {
          const f = parseStreamFrame(s.payload);
          return f['t'] === 'task' && f['status'] === 'failed';
        }),
      );
      const failed = sends
        .map((s) => parseStreamFrame(s.payload))
        .filter((f) => f['t'] === 'task')
        .pop()!;
      expect(failed).toMatchObject({ id: 'task-agent:main:subagent:child-2', status: 'failed' });
    });

    it('emits the awaiting-background-task tool card for sessions_yield', async () => {
      const { sends, connection, adapter } = await setup();

      const handled = adapter.handleInbound(inboundMessage('go do the thing then yield'));
      await waitFor(() => connection.sent.some((f) => f.method === 'sessions.messages.subscribe'));
      connection.respondOk('sessions.messages.subscribe', {});
      await waitFor(() => connection.sent.some((f) => f.method === 'agent'));
      connection.respondOk('agent', { runId: 'run-yield', acceptedAt: Date.now() });
      await waitFor(() => connection.sent.some((f) => f.method === 'agent.wait'));

      connection.emitEvent('session.tool', {
        runId: 'run-yield',
        stream: 'tool',
        data: { phase: 'start', name: 'sessions_yield', toolCallId: 'yield-1', args: {} },
      });

      await waitFor(() =>
        sends.some((s) => {
          const f = parseStreamFrame(s.payload);
          return f['t'] === 'tool' && f['name'] === '⏳ awaiting background task';
        }),
      );
      const card = sends.map((s) => parseStreamFrame(s.payload)).find((f) => f['t'] === 'tool')!;
      expect(card).toMatchObject({
        name: '⏳ awaiting background task',
        output: 'Delegated work is running; results will post here when ready.',
      });

      connection.respondOk('agent.wait', { status: 'ok' });
      await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
      connection.respondOk('chat.history', { messages: [] });
      await handled;
    });
  });

  describe('conversations advertisement (onConnected)', () => {
    it('advertises this controller\'s threads, collapsing the default thread and skipping sub-agent rows', async () => {
      const { sends, connection, adapter } = await setup();

      adapter.onConnected?.({
        requestId: 'req-conv',
        controllerDid: CONTROLLER_DID,
        walletAddress: null,
        agentDid: null,
        identityGranted: true,
        locked: false,
      });

      await waitFor(() => connection.sent.some((f) => f.method === 'sessions.list'));
      const listReq = connection.sent.find((f) => f.method === 'sessions.list');
      expect(listReq?.params).toEqual({ limit: 100, includeDerivedTitles: true });

      connection.respondOk('sessions.list', {
        sessions: [
          { key: 'agent:main:ac2:did:key:ztest', derivedTitle: 'Default thread', updatedAt: 1000 },
          { key: 'agent:main:ac2:did:key:ztest:thread-2', derivedTitle: 'Second thread', updatedAt: 2000 },
          {
            key: 'agent:main:ac2:did:key:ztest:thread-3',
            derivedTitle: 'Should be skipped (spawned)',
            spawnedBy: 'agent:main:ac2:did:key:ztest',
            updatedAt: 2500,
          },
          {
            key: 'agent:main:ac2:did:key:ztest:subagent:child-2',
            derivedTitle: 'Should be skipped (subagent key)',
            updatedAt: 4000,
          },
          { key: 'agent:main:ac2:did:key:zsomeoneelse', derivedTitle: 'Different controller', updatedAt: 5000 },
        ],
      });

      // Let the (separate) default-thread history replay proceed so the test tears down cleanly.
      await waitFor(() => connection.sent.some((f) => f.method === 'chat.history'));
      connection.respondOk('chat.history', { messages: [] });

      await waitFor(() => sends.some((s) => parseStreamFrame(s.payload)['t'] === 'conversations'));
      const frame = sends.map((s) => parseStreamFrame(s.payload)).find((f) => f['t'] === 'conversations')!;
      expect(frame['threads']).toEqual([
        { thid: 'thread-2', title: 'Second thread', updatedAt: 2000 },
        { thid: 'default', title: 'Default thread', updatedAt: 1000 },
      ]);
    });
  });
});

describe('mapHistoryMessages (adapter.ts, pure)', () => {
  it('maps plain turns, a tool call enriched by its toolResult, and an accepted sessions_spawn into ordered Ac2HistoryMessage[]', () => {
    const raw: unknown[] = [
      { role: 'user', content: 'please check the weather', __openclaw: { recordTimestampMs: 100 } },
      { role: 'assistant', content: 'Let me check.', __openclaw: { recordTimestampMs: 150 } },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'get_weather', arguments: { command: 'weather --city NYC' } },
        ],
        __openclaw: { recordTimestampMs: 200 },
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'get_weather',
        content: [{ type: 'text', text: 'Sunny, 24C' }],
        isError: false,
        __openclaw: { recordTimestampMs: 250 },
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-2',
            name: 'sessions_spawn',
            arguments: { task: 'draft a summary', taskName: 'Draft summary' },
          },
        ],
        __openclaw: { recordTimestampMs: 260 },
      },
      {
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'sessions_spawn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'accepted',
              childSessionKey: 'agent:main:subagent:child-9',
              runId: 'child-run-9',
            }),
          },
        ],
        __openclaw: { recordTimestampMs: 270 },
      },
      { role: 'assistant', content: 'All set!', __openclaw: { recordTimestampMs: 300 } },
    ];

    expect(mapHistoryMessages(raw)).toEqual([
      { role: 'user', text: 'please check the weather', at: 100 },
      { role: 'assistant', text: 'Let me check.', at: 150 },
      {
        role: 'tool',
        id: 'tool-call-1',
        name: 'get_weather',
        command: 'weather --city NYC',
        output: 'Sunny, 24C',
        at: 200,
      },
      {
        role: 'task',
        id: 'task-agent:main:subagent:child-9',
        title: 'Draft summary',
        status: 'completed',
        prompt: 'draft a summary',
        at: 270,
      },
      { role: 'assistant', text: 'All set!', at: 300 },
    ]);
  });

  it('skips an assistant message whose only content is a tool call with no text', () => {
    const raw: unknown[] = [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'search' }] },
    ];
    expect(mapHistoryMessages(raw)).toEqual([]);
  });

  it('never throws on malformed entries', () => {
    const raw: unknown[] = [null, 42, 'not an object', { role: 'toolResult' }, { role: 'assistant' }];
    expect(() => mapHistoryMessages(raw)).not.toThrow();
  });
});

describe('daemon integration: openclaw-gateway selection surfaces in daemon.status', () => {
  let stateDir: string;
  let socketDir: string;
  let previousStateDir: string | undefined;
  let daemon: RunningDaemon | undefined;
  let client: ControlClient | undefined;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'ac2-gateway-daemon-test-state-'));
    socketDir = await mkdtemp(join(tmpdir(), 'ac2-gateway-daemon-test-sock-'));
    previousStateDir = process.env['AC2_STATE_DIR'];
    process.env['AC2_STATE_DIR'] = stateDir;
  });

  afterEach(async () => {
    client?.close();
    if (daemon) await daemon.stop().catch(() => {});
    daemon = undefined;
    client = undefined;
    if (previousStateDir === undefined) delete process.env['AC2_STATE_DIR'];
    else process.env['AC2_STATE_DIR'] = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
  });

  it('daemon.status().runtimeAdapter reflects the configured "openclaw-gateway" adapter, with a fake connection wired through', async () => {
    daemon = await runDaemon({
      socketPath: join(socketDir, 'ac2d.sock'),
      keystore: createKeyStoreFixture(stateDir).options(),
      handleSignals: false,
      hostKeystore: false,
      log: () => {},
      providerFactory: (requestId?: string) =>
        new InMemoryChannelProvider({ origin: ORIGIN, ...(requestId ? { requestId } : {}) }),
      runtime: {
        adapter: 'openclaw-gateway',
        config: {
          __connectionFactory: () => new FakeGatewayConnection(),
          __readOpenClawConfigFile: () => undefined,
        },
      },
    });
    client = await connectControl({ path: daemon.socketPath, timeoutMs: 2000 });

    const status = await client.request('daemon.status', {});
    expect(status.runtimeAdapter).toBe('openclaw-gateway');
  });

  it('waits for the gateway adapter to report ready before awaiting a wallet', async () => {
    let connection!: FakeGatewayConnection;
    const built = await runDaemon({
      socketPath: join(socketDir, 'ac2d-gate.sock'),
      keystore: createKeyStoreFixture(stateDir).options(),
      handleSignals: false,
      hostKeystore: false,
      log: () => {},
      providerFactory: (requestId?: string) =>
        new InMemoryChannelProvider({ origin: ORIGIN, ...(requestId ? { requestId } : {}) }),
      runtime: {
        adapter: 'openclaw-gateway',
        config: {
          __connectionFactory: () => {
            connection = new FakeGatewayConnection();
            return connection;
          },
          __readOpenClawConfigFile: () => undefined,
        },
      },
    });
    daemon = built;

    // The gateway handshake has not completed yet, so the daemon must be
    // holding off awaiting a wallet.
    expect(built.status().waitingForRuntime).toBe(true);

    // Complete the handshake → the adapter reports ready → the daemon stops
    // waiting and arms pairing/resume.
    connection.triggerOpen();
    await connection.emitHelloOk();
    await waitFor(() => built.status().waitingForRuntime === false);
  });

  // The point of the whole device-identity path: the daemon authenticates to
  // the gateway as ITSELF — the same `ac2-service` key its service DID is
  // derived from — instead of carrying a second, gateway-only key around.
  it('signs the gateway connect with the service key behind the daemon service DID', async () => {
    let connection!: FakeGatewayConnection;
    const built = await runDaemon({
      socketPath: join(socketDir, 'ac2d-device.sock'),
      keystore: createKeyStoreFixture(stateDir).options(),
      handleSignals: false,
      hostKeystore: false,
      log: () => {},
      providerFactory: (requestId?: string) =>
        new InMemoryChannelProvider({ origin: ORIGIN, ...(requestId ? { requestId } : {}) }),
      runtime: {
        adapter: 'openclaw-gateway',
        config: {
          __connectionFactory: () => {
            connection = new FakeGatewayConnection();
            return connection;
          },
          __readOpenClawConfigFile: () => undefined,
        },
      },
    });
    daemon = built;

    connection.triggerOpen();
    connection.emitEvent('connect.challenge', { nonce: 'nonce-daemon', ts: 1 });
    await waitFor(() => connection.sent.length === 1);

    const params = connection.sent[0]?.params as Record<string, unknown>;
    const device = params['device'] as Record<string, unknown>;
    const publicKeyRaw = Buffer.from(device['publicKey'] as string, 'base64url');
    expect(device['id']).toBe(deviceIdFromPublicKeyRaw(publicKeyRaw));
    expect(device['nonce']).toBe('nonce-daemon');
    // Same key, both faces of it: the gateway device and the service DID.
    expect(publicKeyToDidKey(publicKeyRaw)).toBe(built.status().serviceDid);
  });
});

describe('loader: openclaw-gateway is a registered built-in', () => {
  it('resolves with id "openclaw-gateway" and a handleInbound function', async () => {
    const { host } = createFakeHost();
    const adapter = await loadRuntimeAdapter('openclaw-gateway', host, {
      __connectionFactory: () => new FakeGatewayConnection(),
      __readOpenClawConfigFile: () => undefined,
    });
    expect(adapter.id).toBe('openclaw-gateway');
    expect(typeof adapter.handleInbound).toBe('function');
    await adapter.stop?.();
  });

  it('leaves the default adapter as "socket"', () => {
    expect(DEFAULT_RUNTIME_ADAPTER).toBe('socket');
  });

  it('an unknown specifier still throws the actionable error', async () => {
    const { host } = createFakeHost();
    await expect(
      loadRuntimeAdapter('this-package-definitely-does-not-exist-ac2-test', host),
    ).rejects.toThrow(/npm install/);
  });
});
