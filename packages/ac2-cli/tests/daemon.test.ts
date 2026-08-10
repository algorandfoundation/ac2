/**
 * Tests for the daemon runtime (`runDaemon`): control-socket wiring, agent
 * registration/routing, graceful shutdown, and embedded keystore hosting.
 *
 * Uses the in-memory channel provider as the fake wallet, a temp
 * `AC2_STATE_DIR`, and in-memory keychain/metadata seams — so neither the
 * network nor the OS keychain is ever touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect as netConnect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildKeyResponse,
  buildSigningRejected,
  buildSigningResponse,
} from '@algorandfoundation/ac2-sdk/protocol';
import { isKeyRequest, isSigningRequest } from '@algorandfoundation/ac2-sdk/schema';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';
import { runDaemon, type DaemonRunOptions, type RunningDaemon } from '../src/daemon/run.js';
import { InMemoryChannelProvider } from '@algorandfoundation/ac2-sdk/providers/in-memory';
import { connectControl, type ControlClient } from '../src/control/client.js';
import { CONTROL_PROTOCOL_VERSION, DEFAULT_TARGET_AGENT } from '../src/control/protocol.js';
import { saveAc2State } from '../src/identity/state.js';
import { createKeyStoreFixture } from './helpers/keystore.js';

const ORIGIN = 'https://debug.liquidauth.com';
/** Wallet controller DID stubbed into every `KeyResponse.from`. */
const STUB_CONTROLLER_DID = 'did:key:zStubController';
/** Stub identity public key returned in the bootstrap `KeyResponse`. */
const STUB_AGENT_PK = Buffer.from('agent-identity-public-key').toString('base64');
/** Stub signature bytes the fake wallet returns for an approved signing request. */
const STUB_SIGNATURE = Buffer.from('stub-signature-bytes').toString('base64');

/**
 * Fake wallet: answers the bootstrap `KeyRequest`, optionally answers a
 * `SigningRequest` (approve or reject), and exposes its raw transport.
 */
class FakeWalletProvider extends InMemoryChannelProvider {
  peerTransport: Ac2Transport | undefined;
  /** How the wallet responds to a `SigningRequest` (default: approve). */
  signingBehavior: 'approve' | 'reject' | 'ignore' = 'approve';
  /** The most recent `SigningRequest` the wallet observed, for assertions. */
  lastSigningRequest: { from: string; to: readonly string[]; body: unknown } | undefined;

  protected override onPairingPrepared(peerTransport: Ac2Transport): void {
    this.peerTransport = peerTransport;
    peerTransport.onMessage((msg) => {
      if (isKeyRequest(msg)) {
        peerTransport.send(
          JSON.stringify(
            buildKeyResponse({
              request: msg,
              from: STUB_CONTROLLER_DID,
              body: {
                status: 'approved',
                key_type: 'ed25519',
                material: Buffer.from('stub-material').toString('base64'),
                public_key: STUB_AGENT_PK,
              },
            }),
          ),
        );
        return;
      }
      if (isSigningRequest(msg)) {
        this.lastSigningRequest = { from: msg.from, to: msg.to, body: msg.body };
        if (this.signingBehavior === 'ignore') return;
        if (this.signingBehavior === 'reject') {
          // A user rejection: the wallet replies with SigningRejected, which
          // the daemon maps to a `rejected` outcome carrying the reason.
          peerTransport.send(
            JSON.stringify(
              buildSigningRejected({
                request: msg,
                from: STUB_CONTROLLER_DID,
                reason: 'user_declined',
              }),
            ),
          );
          return;
        }
        peerTransport.send(
          JSON.stringify(
            buildSigningResponse({
              request: msg,
              from: STUB_CONTROLLER_DID,
              body: {
                signature: STUB_SIGNATURE,
                public_key: STUB_AGENT_PK,
                key_type: 'account',
              },
            }),
          ),
        );
      }
    });
  }
}

/** Poll until `predicate` holds (or fail after `timeoutMs`). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Poll `daemon.status` until the wallet connection reports `connected`. */
async function waitForConnected(client: ControlClient, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await client.request('daemon.status', {});
    if (status.connection.state === 'connected') return;
    if (Date.now() > deadline) throw new Error('waitForConnected: not connected in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('runDaemon', () => {
  let stateDir: string;
  let socketDir: string;
  let previousStateDir: string | undefined;
  let daemons: RunningDaemon[];
  let clients: ControlClient[];
  let wallet: FakeWalletProvider | undefined;
  let socketCounter = 0;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'ac2-daemon-test-state-'));
    socketDir = await mkdtemp(join(tmpdir(), 'ac2-daemon-test-sock-'));
    previousStateDir = process.env['AC2_STATE_DIR'];
    process.env['AC2_STATE_DIR'] = stateDir;
    daemons = [];
    clients = [];
    wallet = undefined;
    socketCounter = 0;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    for (const daemon of daemons) {
      try {
        await daemon.stop();
      } catch {
        // Best-effort cleanup.
      }
    }
    if (previousStateDir === undefined) delete process.env['AC2_STATE_DIR'];
    else process.env['AC2_STATE_DIR'] = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
  });

  async function startDaemon(overrides: Partial<DaemonRunOptions> = {}): Promise<RunningDaemon> {
    const daemon = await runDaemon({
      socketPath: join(socketDir, `ac2d-${socketCounter++}.sock`),
      keystore: createKeyStoreFixture(stateDir).options(),
      handleSignals: false,
      hostKeystore: false,
      log: () => {},
      providerFactory: (requestId?: string) => {
        wallet = new FakeWalletProvider({ origin: ORIGIN, ...(requestId ? { requestId } : {}) });
        return wallet;
      },
      ...overrides,
    });
    daemons.push(daemon);
    return daemon;
  }

  async function connect(daemon: RunningDaemon): Promise<ControlClient> {
    const client = await connectControl({ path: daemon.socketPath, timeoutMs: 2000 });
    clients.push(client);
    return client;
  }

  it('reports a well-formed daemon.status', async () => {
    const daemon = await startDaemon();
    const client = await connect(daemon);
    const status = await client.request('daemon.status', {});

    expect(status.protocolVersion).toBe(CONTROL_PROTOCOL_VERSION);
    expect(status.pid).toBe(process.pid);
    expect(typeof status.startedAt).toBe('string');
    expect(status.serviceDid).toMatch(/^did:key:z/);
    expect(status.keystoreSocket).toBeNull();
    expect(status.connection).toEqual({
      state: 'idle',
      requestId: null,
      controllerDid: null,
      walletAddress: null,
      origin: ORIGIN,
      locked: false,
    });
    expect(status.defaultAgent).toBe(DEFAULT_TARGET_AGENT);
    expect(status.agents).toEqual([]);
    // No cycle armed yet — there is nothing scannable to advertise.
    expect(status.pairing).toBeNull();
  });

  /**
   * `daemon.status.pairing` is the READ-ONLY view of the live invitation, so a
   * client can render the QR without calling `pair.start` (which may start a
   * cycle). It must survive the wallet connecting, because the daemon keeps the
   * cycle armed for re-links — that is what lets `pair` show a code even when a
   * wallet is already active.
   */
  it('exposes the live pairing invitation in daemon.status, including while connected', async () => {
    const daemon = await startDaemon();
    const client = await connect(daemon);
    await client.request('agent.hello', { agent: DEFAULT_TARGET_AGENT });

    const pairing = await client.request('pair.start', {});
    const armed = await client.request('daemon.status', {});
    expect(armed.pairing).toEqual(pairing);
    expect(armed.pairing?.qrPayload.length).toBeGreaterThan(0);

    await waitFor(() => wallet?.peerTransport !== undefined);
    await waitForConnected(client);
    const connected = await client.request('daemon.status', {});
    expect(connected.pairing).toEqual(pairing);
  });

  it('routes message.inbound only to the socket registered for that agent', async () => {
    const daemon = await startDaemon();
    const clientA = await connect(daemon);
    const clientB = await connect(daemon);

    await clientA.request('agent.hello', { agent: DEFAULT_TARGET_AGENT });
    await clientB.subscribe(['message.inbound']);

    const aEvents: unknown[] = [];
    const bEvents: unknown[] = [];
    clientA.on('message.inbound', (data) => aEvents.push(data));
    clientB.on('message.inbound', (data) => bEvents.push(data));

    await clientA.request('pair.start', {});
    await waitFor(() => wallet?.peerTransport !== undefined);
    wallet!.peerTransport!.send('hello from the wallet');

    await waitFor(() => aEvents.length > 0);
    expect(aEvents[0]).toMatchObject({
      agent: DEFAULT_TARGET_AGENT,
      channel: 'control',
      payload: 'hello from the wallet',
    });
    expect(bEvents).toEqual([]);
  });

  describe('agent.request (daemon-brokered AC2 passthrough)', () => {
    /** Response types that settle a `ac2/SigningRequest` round-trip. */
    const SIGNING_RESPONSE_TYPES = ['ac2/SigningResponse', 'ac2/SigningRejected'];

    /**
     * Drive a fake wallet through pairing to a connected, identity-granted
     * session so `agent.request` has a real session client to broker through.
     * The `agent.hello` also satisfies the runtime-liveness gate (a registered
     * socket agent counts as an alive runtime) so pairing arms immediately.
     */
    async function pairConnected(daemon: RunningDaemon): Promise<ControlClient> {
      const client = await connect(daemon);
      await client.request('agent.hello', { agent: DEFAULT_TARGET_AGENT });
      await client.request('pair.start', {});
      await waitFor(() => wallet?.peerTransport !== undefined);
      await waitForConnected(client);
      return client;
    }

    it('brokers a full SigningRequest round-trip and relays the wallet SigningResponse', async () => {
      const daemon = await startDaemon();
      const client = await pairConnected(daemon);

      const result = await client.request('agent.request', {
        type: 'ac2/SigningRequest',
        body: {
          description: 'Please sign this test payload',
          encoding: 'base64',
          payload: Buffer.from('to-be-signed').toString('base64'),
          key_type: 'account',
        },
        responseTypes: SIGNING_RESPONSE_TYPES,
      });

      expect(result.status).toBe('response');
      if (result.status !== 'response') throw new Error('expected a relayed response');
      expect(result.message).toMatchObject({
        type: 'ac2/SigningResponse',
        body: {
          signature: STUB_SIGNATURE,
          public_key: STUB_AGENT_PK,
          key_type: 'account',
        },
      });
      // The daemon addressed the request FROM the session's agent identity TO
      // the connected controller — the caller never supplied either DID.
      expect(wallet!.lastSigningRequest?.to).toEqual([STUB_CONTROLLER_DID]);
      expect(wallet!.lastSigningRequest?.body).toMatchObject({
        encoding: 'base64',
        payload: Buffer.from('to-be-signed').toString('base64'),
        description: 'Please sign this test payload',
      });
    });

    it('relays a wallet SigningRejected verbatim for the caller to interpret', async () => {
      const daemon = await startDaemon();
      const client = await pairConnected(daemon);
      wallet!.signingBehavior = 'reject';

      const result = await client.request('agent.request', {
        type: 'ac2/SigningRequest',
        body: {
          description: 'reject me',
          encoding: 'base64',
          payload: Buffer.from('x').toString('base64'),
        },
        responseTypes: SIGNING_RESPONSE_TYPES,
      });

      expect(result.status).toBe('response');
      if (result.status !== 'response') throw new Error('expected a relayed response');
      expect(result.message).toMatchObject({
        type: 'ac2/SigningRejected',
        body: { reason: 'user_declined' },
      });
    });

    it('rejects with not_connected when no wallet is connected', async () => {
      const daemon = await startDaemon();
      const client = await connect(daemon);

      await expect(
        client.request('agent.request', {
          type: 'ac2/SigningRequest',
          body: {
            description: 'no wallet',
            encoding: 'base64',
            payload: Buffer.from('x').toString('base64'),
          },
          responseTypes: SIGNING_RESPONSE_TYPES,
        }),
      ).rejects.toMatchObject({ code: 'not_connected' });
    });

    it('rejects a malformed agent.request (missing responseTypes) with bad_request', async () => {
      const daemon = await startDaemon();
      const client = await connect(daemon);

      await expect(
        client.request('agent.request', {
          type: 'ac2/SigningRequest',
          body: { description: 'missing responseTypes' },
        } as never),
      ).rejects.toMatchObject({ code: 'bad_request' });
    });
  });

  it('rejects a duplicate agent.hello with code agent_taken', async () => {
    const daemon = await startDaemon();
    const clientA = await connect(daemon);
    const clientB = await connect(daemon);

    const hello = await clientA.request('agent.hello', { agent: 'dup-agent' });
    expect(hello.protocolVersion).toBe(CONTROL_PROTOCOL_VERSION);

    await expect(clientB.request('agent.hello', { agent: 'dup-agent' })).rejects.toMatchObject({
      code: 'agent_taken',
    });
  });

  it('daemon.stop resolves closed', async () => {
    const daemon = await startDaemon();
    const client = await connect(daemon);

    const result = await client.request('daemon.stop', {});
    expect(result).toEqual({ stopping: true });

    await daemon.closed;
  });

  it('daemon.stop exits the process explicitly when the daemon owns it', async () => {
    // A paired daemon can hold handles that keep the event loop alive after a
    // completed teardown (native WebRTC peers, socket.io timers) — trusting
    // the loop to drain left stale daemons running across CLI reinstalls, so
    // an owning daemon must exit itself once the graceful stop is done.
    const exits: number[] = [];
    const daemon = await startDaemon({ handleSignals: true, exit: (code) => exits.push(code) });
    const client = await connect(daemon);

    const result = await client.request('daemon.stop', {});
    expect(result).toEqual({ stopping: true });

    await daemon.closed;
    await waitFor(() => exits.length > 0);
    expect(exits).toEqual([0]);
  });

  it('exits non-zero via the failsafe when a graceful stop hangs', async () => {
    let releaseDispose: () => void = () => {};
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    /** A pairing handle whose `dispose` wedges the broker's teardown. */
    class HangingTeardownProvider extends FakeWalletProvider {
      override async startPairing(
        opts: Parameters<InMemoryChannelProvider['startPairing']>[0] = {},
      ) {
        const handle = await super.startPairing(opts);
        return { ...handle, dispose: () => disposeGate };
      }
    }
    const exits: number[] = [];
    const daemon = await startDaemon({
      handleSignals: true,
      stopExitFailsafeMs: 150,
      exit: (code) => exits.push(code),
      providerFactory: () => new HangingTeardownProvider({ origin: ORIGIN }),
    });
    const client = await connect(daemon);
    await client.request('pair.start', {});

    const result = await client.request('daemon.stop', {});
    expect(result).toEqual({ stopping: true });

    // The graceful stop is stuck on the hanging dispose — only the failsafe
    // can exit, and it must report the abnormal teardown (exit code 1).
    await waitFor(() => exits.length > 0, 3000);
    expect(exits).toEqual([1]);

    // Unwedge the teardown so afterEach's `daemon.stop()` can settle.
    releaseDispose();
    await daemon.closed;
  });

  it('hosts the embedded keystore service and reports its socket path', async () => {
    const keystoreSocketPath = join(socketDir, 'keystore.sock');
    const daemon = await startDaemon({ hostKeystore: true, keystoreSocketPath });
    const client = await connect(daemon);

    const status = await client.request('daemon.status', {});
    expect(status.keystoreSocket).toBe(keystoreSocketPath);

    await new Promise<void>((resolve, reject) => {
      const socket = netConnect(keystoreSocketPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    });
  }, 15000);

  it('reuses an already-listening keystore socket instead of hosting its own', async () => {
    const keystoreSocketPath = join(socketDir, 'existing-keystore.sock');
    const dummy: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      dummy.once('error', reject);
      dummy.listen(keystoreSocketPath, () => resolve());
    });

    try {
      const daemon = await startDaemon({ hostKeystore: true, keystoreSocketPath });
      const client = await connect(daemon);

      const status = await client.request('daemon.status', {});
      expect(status.keystoreSocket).toBe(keystoreSocketPath);
      expect(dummy.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => dummy.close(() => resolve()));
    }
  });

  it('resumes an existing connection on startup by re-arming pairing on the same requestId', async () => {
    // Simulate a wallet that had paired before a daemon restart.
    saveAc2State({
      requestId: 'prior-request-id',
      connections: {
        'prior-request-id': {
          requestId: 'prior-request-id',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          conversations: {},
        },
      },
    });

    let providerRequestId: string | undefined;
    const daemon = await runDaemon({
      socketPath: join(socketDir, `ac2d-${socketCounter++}.sock`),
      keystore: createKeyStoreFixture(stateDir).options(),
      handleSignals: false,
      hostKeystore: false,
      // Isolate resume mechanics from the runtime-liveness gate (tested
      // separately below): arm immediately without waiting for a runtime.
      waitForRuntime: false,
      log: () => {},
      providerFactory: (requestId?: string) => {
        providerRequestId = requestId;
        wallet = new FakeWalletProvider({ origin: ORIGIN, ...(requestId ? { requestId } : {}) });
        return wallet;
      },
    });
    daemons.push(daemon);

    // The daemon must re-arm pairing on its own (no manual `pair.start`) and
    // reuse the persisted requestId so the returning wallet reconnects in place.
    await waitFor(() => daemon.status().connection.state !== 'idle');
    expect(providerRequestId).toBe('prior-request-id');
    expect(daemon.status().connection.requestId).toBe('prior-request-id');
  });

  it('stays idle on startup when resumeConnections is disabled', async () => {
    saveAc2State({
      requestId: 'prior-request-id',
      connections: {
        'prior-request-id': {
          requestId: 'prior-request-id',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          conversations: {},
        },
      },
    });

    let providerBuilt = false;
    const daemon = await runDaemon({
      socketPath: join(socketDir, `ac2d-${socketCounter++}.sock`),
      keystore: createKeyStoreFixture(stateDir).options(),
      handleSignals: false,
      hostKeystore: false,
      resumeConnections: false,
      // Isolate the `resumeConnections` flag from the runtime-liveness gate.
      waitForRuntime: false,
      log: () => {},
      providerFactory: (requestId?: string) => {
        providerBuilt = true;
        wallet = new FakeWalletProvider({ origin: ORIGIN, ...(requestId ? { requestId } : {}) });
        return wallet;
      },
    });
    daemons.push(daemon);

    // Give any (unexpected) auto-resume a chance to fire before asserting.
    await new Promise((r) => setTimeout(r, 50));
    expect(providerBuilt).toBe(false);
    expect(daemon.status().connection.state).toBe('idle');
  });

  it('waits for an agent runtime before resuming a persisted connection (socket adapter)', async () => {
    // A wallet that had paired before a daemon restart.
    saveAc2State({
      requestId: 'prior-request-id',
      connections: {
        'prior-request-id': {
          requestId: 'prior-request-id',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          conversations: {},
        },
      },
    });

    let providerRequestId: string | undefined;
    const daemon = await runDaemon({
      socketPath: join(socketDir, `ac2d-${socketCounter++}.sock`),
      keystore: createKeyStoreFixture(stateDir).options(),
      handleSignals: false,
      hostKeystore: false,
      // Default gate ON: no runtime is alive yet (the default `socket` adapter
      // has no agent registered), so the daemon must NOT resume yet.
      log: () => {},
      providerFactory: (requestId?: string) => {
        providerRequestId = requestId;
        wallet = new FakeWalletProvider({ origin: ORIGIN, ...(requestId ? { requestId } : {}) });
        return wallet;
      },
    });
    daemons.push(daemon);

    // Give any (wrongly-armed) resume a chance to fire before asserting it did NOT.
    await new Promise((r) => setTimeout(r, 50));
    expect(daemon.status().waitingForRuntime).toBe(true);
    expect(daemon.status().connection.state).toBe('idle');
    expect(providerRequestId).toBeUndefined();

    // A control-socket agent registering is the `socket` adapter's liveness
    // signal — now the daemon resumes on the same requestId.
    const client = await connect(daemon);
    await client.request('agent.hello', { agent: DEFAULT_TARGET_AGENT });

    await waitFor(() => daemon.status().connection.state !== 'idle');
    expect(providerRequestId).toBe('prior-request-id');
    expect(daemon.status().connection.requestId).toBe('prior-request-id');
    expect(daemon.status().waitingForRuntime).toBe(false);
  });

  it('reports waitingForRuntime and stops waiting once an agent registers (fresh install)', async () => {
    // No persisted connection: nothing to resume, but the daemon should still
    // hold off "awaiting a wallet" until a runtime is alive, then stop waiting.
    const daemon = await startDaemon();
    expect(daemon.status().waitingForRuntime).toBe(true);
    expect(daemon.status().connection.state).toBe('idle');

    const client = await connect(daemon);
    await client.request('agent.hello', { agent: DEFAULT_TARGET_AGENT });

    await waitFor(() => daemon.status().waitingForRuntime === false);
    // Nothing to resume on a fresh install, so it stays idle — but is no
    // longer gated on a runtime.
    expect(daemon.status().connection.state).toBe('idle');
  });
});
