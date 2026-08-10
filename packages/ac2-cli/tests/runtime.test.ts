/**
 * Tests for the runtime-adapter seam (`src/runtime/loader.ts`,
 * `src/runtime/socket-adapter.ts`) as driven by a real in-process daemon
 * (`runDaemon`) — see `daemon.test.ts`/`broker.test.ts` for the same
 * pattern: the in-memory channel provider stands in for the wallet, so
 * pairing, identity bootstrap, and the control socket are all genuine.
 *
 * Third-party adapters are exercised via tiny `.mjs` modules written to a
 * temp directory and loaded through `runtime.adapter` by absolute path
 * (Node's dynamic `import()` accepts an absolute path directly), so the
 * loader's "npm specifier" path is exercised for real, not mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildKeyResponse } from '@algorandfoundation/ac2-sdk/protocol';
import { isKeyRequest } from '@algorandfoundation/ac2-sdk/schema';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';
import { InMemoryChannelProvider } from '@algorandfoundation/ac2-sdk/providers/in-memory';
import { runDaemon, type DaemonRunOptions, type RunningDaemon } from '../src/daemon/run.js';
import { connectControl, type ControlClient } from '../src/control/client.js';
import { DEFAULT_TARGET_AGENT } from '../src/control/protocol.js';
import { createKeyStoreFixture } from './helpers/keystore.js';

const ORIGIN = 'https://debug.liquidauth.com';
const STUB_CONTROLLER_DID = 'did:key:zStubController';
const STUB_AGENT_PK = Buffer.from('agent-identity-public-key').toString('base64');

/** Fake wallet: answers the bootstrap `KeyRequest` and exposes its raw transport. */
class FakeWalletProvider extends InMemoryChannelProvider {
  peerTransport: Ac2Transport | undefined;
  received: string[] = [];

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
      }
    });
    peerTransport.onRawMessage?.((payload) => {
      this.received.push(payload);
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

/** A single recorded adapter-hook invocation, in call order. */
type AdapterEvent =
  | { hook: 'start' }
  | { hook: 'onConnected'; info: unknown }
  | { hook: 'handleInbound'; message: unknown }
  | { hook: 'onDisconnected'; reason: string }
  | { hook: 'stop' };

/**
 * A fake `createRuntimeAdapter` module written to disk and loaded by
 * absolute path — real dynamic `import()`, not an in-process mock. Events
 * are recorded through a `globalThis` slot keyed by `key` so the test can
 * read them back without the temp module needing to reach into the test
 * file itself.
 */
async function writeFakeAdapterModule(
  dir: string,
  key: string,
  opts: { throwOn?: AdapterEvent['hook']; sendOnConnected?: string } = {},
): Promise<{ path: string; events: AdapterEvent[] }> {
  const events: AdapterEvent[] = [];
  (globalThis as Record<string, unknown>)[key] = events;

  const throwLine = (hook: string): string =>
    opts.throwOn === hook ? `if (true) throw new Error('boom from ${hook}');` : '';

  const code = `
export function createRuntimeAdapter(host, config) {
  const events = globalThis[${JSON.stringify(key)}];
  return {
    id: 'fake',
    async start() {
      ${throwLine('start')}
      events.push({ hook: 'start' });
    },
    async onConnected(info) {
      ${throwLine('onConnected')}
      events.push({ hook: 'onConnected', info });
      ${opts.sendOnConnected ? `await host.send(${JSON.stringify(opts.sendOnConnected)});` : ''}
    },
    async handleInbound(message) {
      ${throwLine('handleInbound')}
      events.push({ hook: 'handleInbound', message });
    },
    async onDisconnected(reason) {
      ${throwLine('onDisconnected')}
      events.push({ hook: 'onDisconnected', reason });
    },
    async stop() {
      ${throwLine('stop')}
      events.push({ hook: 'stop' });
    },
  };
}
`;
  const path = join(dir, `${key}.mjs`);
  await writeFile(path, code, 'utf8');
  return { path, events };
}

describe('runtime adapters', () => {
  let stateDir: string;
  let socketDir: string;
  let moduleDir: string;
  let previousStateDir: string | undefined;
  let daemons: RunningDaemon[];
  let clients: ControlClient[];
  let wallet: FakeWalletProvider | undefined;
  let socketCounter: number;
  let logs: string[];

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'ac2-runtime-test-state-'));
    socketDir = await mkdtemp(join(tmpdir(), 'ac2-runtime-test-sock-'));
    moduleDir = await mkdtemp(join(tmpdir(), 'ac2-runtime-test-mod-'));
    previousStateDir = process.env['AC2_STATE_DIR'];
    process.env['AC2_STATE_DIR'] = stateDir;
    daemons = [];
    clients = [];
    wallet = undefined;
    socketCounter = 0;
    logs = [];
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
    await rm(moduleDir, { recursive: true, force: true });
  });

  async function startDaemon(overrides: Partial<DaemonRunOptions> = {}): Promise<RunningDaemon> {
    const daemon = await runDaemon({
      socketPath: join(socketDir, `ac2d-${socketCounter++}.sock`),
      keystore: createKeyStoreFixture(stateDir).options(),
      handleSignals: false,
      hostKeystore: false,
      log: (line: string) => logs.push(line),
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

  it('defaults to the built-in "socket" adapter and reports it in daemon.status', async () => {
    const daemon = await startDaemon();
    const client = await connect(daemon);
    const status = await client.request('daemon.status', {});
    expect(status.runtimeAdapter).toBe('socket');
  });

  it('the "socket" adapter still routes message.inbound to the registered agent socket', async () => {
    const daemon = await startDaemon();
    const clientA = await connect(daemon);

    await clientA.request('agent.hello', { agent: DEFAULT_TARGET_AGENT });
    const inbound: unknown[] = [];
    clientA.on('message.inbound', (data) => inbound.push(data));

    await clientA.request('pair.start', {});
    await waitFor(() => wallet?.peerTransport !== undefined);
    wallet!.peerTransport!.send('hello from the wallet');

    await waitFor(() => inbound.length > 0);
    expect(inbound[0]).toMatchObject({
      agent: DEFAULT_TARGET_AGENT,
      channel: 'control',
      payload: 'hello from the wallet',
    });
  });

  it('an unknown specifier logs one actionable error and leaves the daemon running with no adapter', async () => {
    const daemon = await startDaemon({
      runtime: { adapter: 'this-package-definitely-does-not-exist-ac2-test' },
    });
    const client = await connect(daemon);

    const status = await client.request('daemon.status', {});
    expect(status.runtimeAdapter).toBeNull();

    expect(
      logs.some(
        (line) =>
          line.includes('this-package-definitely-does-not-exist-ac2-test') &&
          line.includes('npm install'),
      ),
    ).toBe(true);

    // The daemon is still fully usable (control socket + pairing unaffected).
    await client.request('pair.start', {});
    await waitFor(() => wallet?.peerTransport !== undefined);
  });

  it('a module missing the createRuntimeAdapter export logs one actionable error and the daemon keeps running', async () => {
    const path = join(moduleDir, 'no-export.mjs');
    await writeFile(path, 'export const somethingElse = 1;\n', 'utf8');

    const daemon = await startDaemon({ runtime: { adapter: path } });
    const client = await connect(daemon);

    const status = await client.request('daemon.status', {});
    expect(status.runtimeAdapter).toBeNull();
    expect(
      logs.some((line) => line.includes(path) && line.includes('createRuntimeAdapter')),
    ).toBe(true);
  });

  it('a throwing factory logs one actionable error and the daemon keeps running', async () => {
    const path = join(moduleDir, 'throwing.mjs');
    await writeFile(
      path,
      "export function createRuntimeAdapter() { throw new Error('factory boom'); }\n",
      'utf8',
    );

    const daemon = await startDaemon({ runtime: { adapter: path } });
    const client = await connect(daemon);

    const status = await client.request('daemon.status', {});
    expect(status.runtimeAdapter).toBeNull();
    expect(logs.some((line) => line.includes(path) && line.includes('factory boom'))).toBe(true);
  });

  it('a factory returning an invalid shape logs one actionable error and the daemon keeps running', async () => {
    const path = join(moduleDir, 'bad-shape.mjs');
    await writeFile(
      path,
      'export function createRuntimeAdapter() { return { id: 42 }; }\n',
      'utf8',
    );

    const daemon = await startDaemon({ runtime: { adapter: path } });
    const client = await connect(daemon);

    const status = await client.request('daemon.status', {});
    expect(status.runtimeAdapter).toBeNull();
    expect(logs.some((line) => line.includes(path) && line.includes('invalid adapter'))).toBe(
      true,
    );
  });

  it('drives a loaded adapter through start → onConnected → handleInbound → onDisconnected → stop, in order', async () => {
    const { path, events } = await writeFakeAdapterModule(moduleDir, 'ac2TestLifecycle');

    const daemon = await startDaemon({ runtime: { adapter: path } });
    const client = await connect(daemon);

    await waitFor(() => events.some((e) => e.hook === 'start'));

    await client.request('pair.start', {});
    await waitFor(() => wallet?.peerTransport !== undefined);
    await waitFor(() => events.some((e) => e.hook === 'onConnected'));

    const connectedEvent = events.find((e) => e.hook === 'onConnected');
    expect(connectedEvent).toMatchObject({
      hook: 'onConnected',
      info: {
        controllerDid: STUB_CONTROLLER_DID,
        locked: false,
        identityGranted: true,
      },
    });

    wallet!.peerTransport!.send('hello from the wallet');
    await waitFor(() => events.some((e) => e.hook === 'handleInbound'));
    const inboundEvent = events.find((e) => e.hook === 'handleInbound');
    expect(inboundEvent).toMatchObject({
      hook: 'handleInbound',
      message: { channel: 'control', payload: 'hello from the wallet' },
    });
    // No `agent` field leaks into the adapter-facing message shape.
    expect((inboundEvent as { message: Record<string, unknown> }).message['agent']).toBeUndefined();

    wallet!.peerTransport!.close();
    await waitFor(() => events.some((e) => e.hook === 'onDisconnected'));

    await daemon.stop();
    await waitFor(() => events.some((e) => e.hook === 'stop'));

    const order = events.map((e) => e.hook);
    expect(order.indexOf('start')).toBeLessThan(order.indexOf('onConnected'));
    expect(order.indexOf('onConnected')).toBeLessThan(order.indexOf('handleInbound'));
    expect(order.indexOf('handleInbound')).toBeLessThan(order.indexOf('onDisconnected'));
    expect(order.indexOf('onDisconnected')).toBeLessThan(order.indexOf('stop'));
  });

  it('a locked connection gets onConnected(locked: true) and no handleInbound, but host.send still delivers', async () => {
    // Pre-bind the daemon to a different controller so this connection is refused (see broker.test.ts).
    const { saveAc2State } = await import('../src/identity/state.js');
    saveAc2State({
      identity: {
        agentDid: 'did:key:zBoundAgent',
        controllerDid: 'did:key:zBoundWallet',
        publicKey: 'unused',
      },
    });

    const { path, events } = await writeFakeAdapterModule(moduleDir, 'ac2TestLocked', {
      sendOnConnected: 'you are not registered',
    });

    class ControllerWalletProvider extends FakeWalletProvider {
      override async startPairing(opts: Parameters<FakeWalletProvider['startPairing']>[0] = {}) {
        const handle = await super.startPairing(opts);
        return {
          ...handle,
          connect: async () => {
            const paired = await handle.connect();
            return { ...paired, peer: { wallet: 'zOtherWallet' } };
          },
        };
      }
    }

    let controllerWallet: ControllerWalletProvider | undefined;
    const daemon = await startDaemon({
      runtime: { adapter: path },
      providerFactory: (requestId?: string) => {
        controllerWallet = new ControllerWalletProvider({
          origin: ORIGIN,
          ...(requestId ? { requestId } : {}),
        });
        return controllerWallet;
      },
    });
    const client = await connect(daemon);

    await client.request('pair.start', {});
    await waitFor(() => controllerWallet?.peerTransport !== undefined);
    await waitFor(() => events.some((e) => e.hook === 'onConnected'));

    const connectedEvent = events.find((e) => e.hook === 'onConnected');
    expect(connectedEvent).toMatchObject({ hook: 'onConnected', info: { locked: true } });

    // `host.send` was called from inside `onConnected` above — it must still deliver.
    await waitFor(() => controllerWallet!.received.includes('you are not registered'));

    // Inbound traffic must never reach the adapter while locked.
    controllerWallet!.peerTransport!.send('hello from the wrong wallet');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.some((e) => e.hook === 'handleInbound')).toBe(false);
  });

  it('resolves the adapter from AC2_RUNTIME/AC2_RUNTIME_CONFIG when no explicit option is given', async () => {
    const { path, events } = await writeFakeAdapterModule(moduleDir, 'ac2TestEnvConfig');
    const previousRuntime = process.env['AC2_RUNTIME'];
    const previousConfig = process.env['AC2_RUNTIME_CONFIG'];
    process.env['AC2_RUNTIME'] = path;
    process.env['AC2_RUNTIME_CONFIG'] = JSON.stringify({ hello: 'world' });
    try {
      const daemon = await startDaemon();
      const client = await connect(daemon);
      await waitFor(() => events.some((e) => e.hook === 'start'));

      const status = await client.request('daemon.status', {});
      expect(status.runtimeAdapter).toBe('fake');
    } finally {
      if (previousRuntime === undefined) delete process.env['AC2_RUNTIME'];
      else process.env['AC2_RUNTIME'] = previousRuntime;
      if (previousConfig === undefined) delete process.env['AC2_RUNTIME_CONFIG'];
      else process.env['AC2_RUNTIME_CONFIG'] = previousConfig;
    }
  });

  it('tolerates malformed AC2_RUNTIME_CONFIG with a clear log instead of throwing', async () => {
    const { path } = await writeFakeAdapterModule(moduleDir, 'ac2TestBadEnvConfig');
    const previousRuntime = process.env['AC2_RUNTIME'];
    const previousConfig = process.env['AC2_RUNTIME_CONFIG'];
    process.env['AC2_RUNTIME'] = path;
    process.env['AC2_RUNTIME_CONFIG'] = '{ this is not valid JSON';
    try {
      const daemon = await startDaemon();
      const client = await connect(daemon);

      const status = await client.request('daemon.status', {});
      expect(status.runtimeAdapter).toBe('fake');
      expect(logs.some((line) => line.includes('AC2_RUNTIME_CONFIG'))).toBe(true);
    } finally {
      if (previousRuntime === undefined) delete process.env['AC2_RUNTIME'];
      else process.env['AC2_RUNTIME'] = previousRuntime;
      if (previousConfig === undefined) delete process.env['AC2_RUNTIME_CONFIG'];
      else process.env['AC2_RUNTIME_CONFIG'] = previousConfig;
    }
  });

  it('a hook that throws is caught and logged, and kills neither the connection nor the daemon', async () => {
    const { path, events } = await writeFakeAdapterModule(moduleDir, 'ac2TestThrowing', {
      throwOn: 'handleInbound',
    });

    const daemon = await startDaemon({ runtime: { adapter: path } });
    const client = await connect(daemon);

    await client.request('pair.start', {});
    await waitFor(() => wallet?.peerTransport !== undefined);
    await waitFor(() => events.some((e) => e.hook === 'onConnected'));

    wallet!.peerTransport!.send('this will make handleInbound throw');
    await waitFor(() => logs.some((line) => line.includes('boom from handleInbound')));

    // The wallet connection is still alive: `agent.send` still delivers.
    const result = await client.request('agent.send', {
      agent: DEFAULT_TARGET_AGENT,
      channel: 'control',
      payload: 'still alive',
    });
    expect(result.delivered).toBe(true);
    await waitFor(() => wallet!.received.includes('still alive'));

    // The daemon itself is still alive.
    const status = await client.request('daemon.status', {});
    expect(status.connection.state).toBe('connected');
  });

  it('persists an explicitly-selected adapter and reuses it on a bare restart', async () => {
    const { path } = await writeFakeAdapterModule(moduleDir, 'ac2TestPersistExplicit');

    // First run: explicit selection loads and is remembered on disk.
    const daemonA = await startDaemon({ runtime: { adapter: path } });
    const clientA = await connect(daemonA);
    expect((await clientA.request('daemon.status', {})).runtimeAdapter).toBe('fake');
    const { loadRuntimeSelection } = await import('../src/identity/state.js');
    expect(loadRuntimeSelection()?.adapter).toBe(path);
    await daemonA.stop();

    // Bare restart (no option, no env): the persisted adapter is reused instead
    // of reverting to the `socket` default.
    const daemonB = await startDaemon();
    const clientB = await connect(daemonB);
    const statusB = await clientB.request('daemon.status', {});
    expect(statusB.runtimeAdapter).toBe('fake');
    expect(logs.some((line) => line.includes('reusing persisted runtime adapter'))).toBe(true);
  });

  it('persists an AC2_RUNTIME-selected adapter and reuses it after the env is gone', async () => {
    const { path } = await writeFakeAdapterModule(moduleDir, 'ac2TestPersistEnv');
    const previousRuntime = process.env['AC2_RUNTIME'];
    process.env['AC2_RUNTIME'] = path;
    let daemonA: RunningDaemon;
    try {
      daemonA = await startDaemon();
      const clientA = await connect(daemonA);
      expect((await clientA.request('daemon.status', {})).runtimeAdapter).toBe('fake');
    } finally {
      if (previousRuntime === undefined) delete process.env['AC2_RUNTIME'];
      else process.env['AC2_RUNTIME'] = previousRuntime;
    }
    await daemonA!.stop();

    const daemonB = await startDaemon();
    const clientB = await connect(daemonB);
    expect((await clientB.request('daemon.status', {})).runtimeAdapter).toBe('fake');
  });

  it('does not persist (and never reuses) an adapter that failed to load', async () => {
    // An explicit selection that cannot load must not be remembered.
    const daemonA = await startDaemon({
      runtime: { adapter: 'this-package-definitely-does-not-exist-ac2-persist' },
    });
    const clientA = await connect(daemonA);
    expect((await clientA.request('daemon.status', {})).runtimeAdapter).toBeNull();
    const { loadRuntimeSelection } = await import('../src/identity/state.js');
    expect(loadRuntimeSelection()).toBeUndefined();
    await daemonA.stop();

    // A bare restart therefore falls back to the built-in `socket` default.
    const daemonB = await startDaemon();
    const clientB = await connect(daemonB);
    expect((await clientB.request('daemon.status', {})).runtimeAdapter).toBe('socket');
  });

  it('strips internal "__"-prefixed config seams from the persisted selection', async () => {
    const { path } = await writeFakeAdapterModule(moduleDir, 'ac2TestPersistConfig');
    const daemon = await startDaemon({
      runtime: { adapter: path, config: { keep: 'me', __seam: () => {} } },
    });
    const client = await connect(daemon);
    expect((await client.request('daemon.status', {})).runtimeAdapter).toBe('fake');
    const { loadRuntimeSelection } = await import('../src/identity/state.js');
    const persisted = loadRuntimeSelection();
    expect(persisted?.config).toEqual({ keep: 'me' });
  });
});
