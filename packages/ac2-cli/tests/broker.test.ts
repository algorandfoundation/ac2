/**
 * Tests for the daemon's wallet-connection broker.
 *
 * Uses the in-memory channel provider as the fake wallet, a temp
 * `AC2_STATE_DIR`, and a keystore wired to in-memory keychain/metadata seams —
 * so neither the OS keychain nor the network is ever touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildKeyResponse } from '@algorandfoundation/ac2-sdk/protocol';
import { isKeyRequest } from '@algorandfoundation/ac2-sdk/schema';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';
import type {
  Ac2ChannelProvider,
  Ac2PairingHandle,
  Ac2StartPairingOptions,
} from '@algorandfoundation/ac2-sdk/signaling';
import type { KeyringBinding } from '@algorandfoundation/keystore-node';
import { createConnectionBroker, type ConnectionBroker } from '../src/daemon/broker.js';
import { InMemoryChannelProvider, type InMemoryChannelProviderOptions } from '@algorandfoundation/ac2-sdk/providers/in-memory';
import { SERVICE_KEY_ID, type Ac2KeyStore } from '../src/keystore/index.js';
import { loadAc2State, saveAc2State } from '../src/identity/state.js';
import { generateAgentKeyMaterial } from './helpers/identity.js';
import { createKeyStoreFixture, type KeyStoreFixture } from './helpers/keystore.js';
import type { ControlEventName, ControlEvents } from '../src/control/protocol.js';

const ORIGIN = 'https://debug.liquidauth.com';
/** Wallet controller DID stubbed into every `KeyResponse.from`. */
const STUB_CONTROLLER_DID = 'did:key:zStubController';
/**
 * A real Ed25519 keypair the fake wallet grants as the agent identity: the
 * keystore only accepts genuine 32-byte material, exactly as a wallet sends it.
 */
const AGENT_KEY = generateAgentKeyMaterial();

/** Fake wallet: answers the bootstrap `KeyRequest` and records raw frames. */
class FakeWalletProvider extends InMemoryChannelProvider {
  received: string[] = [];
  peerTransport: Ac2Transport | undefined;

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
                material: AGENT_KEY.material,
                public_key: AGENT_KEY.publicKey,
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

/**
 * Wraps {@link FakeWalletProvider} to also report a `peer.wallet` account on
 * the paired channel, so the controller-binding decision (`locked` /
 * `reuse`) can be driven from a test without a real Liquid Auth link.
 */
class ControllerWalletProvider extends FakeWalletProvider {
  constructor(
    private readonly walletAccount: string,
    opts: InMemoryChannelProviderOptions,
  ) {
    super(opts);
  }

  override async startPairing(opts: Ac2StartPairingOptions = {}): Promise<Ac2PairingHandle> {
    const handle = await super.startPairing(opts);
    return {
      ...handle,
      connect: async () => {
        const paired = await handle.connect();
        return { ...paired, peer: { wallet: this.walletAccount } };
      },
    };
  }
}

/** Fake wallet that rejects the bootstrap `KeyRequest` (the `BootstrapError` path). */
class DenyingWalletProvider extends InMemoryChannelProvider {
  protected override onPairingPrepared(peerTransport: Ac2Transport): void {
    peerTransport.onMessage((msg) => {
      if (isKeyRequest(msg)) {
        peerTransport.send(
          JSON.stringify(
            buildKeyResponse({
              request: msg,
              from: STUB_CONTROLLER_DID,
              body: {
                status: 'rejected',
                key_type: 'ed25519',
                material: '',
                public_key: '',
                reason: 'test denial',
              },
            }),
          ),
        );
      }
    });
  }
}

/**
 * A provider whose pairing handle is built successfully but whose `connect()`
 * rejects instantly, with dead signaling — i.e. the shape the broker's
 * reconnect loop hit in production. Each `startPairing()` stands for one fresh
 * signaling socket on the server, so `built` is the socket count.
 */
class FailingPairingProvider implements Ac2ChannelProvider {
  built = 0;

  async startPairing(): Promise<Ac2PairingHandle> {
    this.built += 1;
    return {
      pairing: { qrPayload: 'qr-fail', metadata: { origin: ORIGIN, requestId: 'req-fail' } },
      connect: async () => {
        throw new Error('Signaling engine closed: transport close');
      },
      isSignalingAlive: () => false,
      dispose: async () => {},
    };
  }
}

type RecordedEvent = { event: ControlEventName; data: unknown };

/** Poll until `predicate` holds (or fail after `timeoutMs`). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('createConnectionBroker', () => {
  let stateDir: string;
  let previousStateDir: string | undefined;
  let fixture: KeyStoreFixture;
  let keystore: Ac2KeyStore;
  let events: RecordedEvent[];
  let wallet: FakeWalletProvider | undefined;
  let brokers: ConnectionBroker[];

  const emit = <E extends ControlEventName>(event: E, data: ControlEvents[E]): void => {
    events.push({ event, data });
  };

  const makeBroker = (
    store: Ac2KeyStore = keystore,
    providerFactoryOverride?: (requestId?: string) => InMemoryChannelProvider,
  ): ConnectionBroker => {
    const broker = createConnectionBroker({
      providerFactory:
        providerFactoryOverride ??
        ((requestId?: string) => {
          wallet = new FakeWalletProvider({
            origin: ORIGIN,
            ...(requestId ? { requestId } : {}),
          });
          return wallet;
        }),
      origin: ORIGIN,
      keystore: store,
      emit,
    });
    brokers.push(broker);
    return broker;
  };

  const eventsOf = (name: ControlEventName): RecordedEvent[] =>
    events.filter((e) => e.event === name);

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'ac2-broker-test-'));
    previousStateDir = process.env['AC2_STATE_DIR'];
    process.env['AC2_STATE_DIR'] = stateDir;
    fixture = createKeyStoreFixture(stateDir);
    keystore = fixture.create();
    events = [];
    wallet = undefined;
    brokers = [];
  });

  afterEach(async () => {
    for (const broker of brokers) {
      try {
        await broker.stop();
      } catch {
        // Best-effort cleanup.
      }
    }
    if (previousStateDir === undefined) delete process.env['AC2_STATE_DIR'];
    else process.env['AC2_STATE_DIR'] = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });

  it('emits connection.pairing then connection.connected once the wallet connects', async () => {
    const broker = makeBroker();
    await broker.start();

    const pairing = await broker.startPairing();
    expect(pairing.origin).toBe(ORIGIN);
    expect(pairing.requestId.length).toBeGreaterThan(0);
    expect(pairing.qrPayload).toContain(pairing.requestId);

    await waitFor(() => eventsOf('connection.connected').length > 0);

    const pairingIdx = events.findIndex((e) => e.event === 'connection.pairing');
    const connectedIdx = events.findIndex((e) => e.event === 'connection.connected');
    expect(pairingIdx).toBeGreaterThanOrEqual(0);
    expect(connectedIdx).toBeGreaterThan(pairingIdx);

    const pairingEvent = eventsOf('connection.pairing')[0]!
      .data as ControlEvents['connection.pairing'];
    expect(pairingEvent).toEqual({
      requestId: pairing.requestId,
      qrPayload: pairing.qrPayload,
      origin: ORIGIN,
    });

    const connectedEvent = eventsOf('connection.connected')[0]!
      .data as ControlEvents['connection.connected'];
    expect(connectedEvent.requestId).toBe(pairing.requestId);
    expect(connectedEvent.controllerDid).toBe(STUB_CONTROLLER_DID);
    expect(connectedEvent.locked).toBe(false);
    expect(connectedEvent.identityGranted).toBe(true);
    expect(connectedEvent.agentDid).toMatch(/^did:key:z/);

    const snapshot = broker.snapshot();
    expect(snapshot.state).toBe('connected');
    expect(snapshot.requestId).toBe(pairing.requestId);
    expect(snapshot.controllerDid).toBe(STUB_CONTROLLER_DID);
    expect(snapshot.origin).toBe(ORIGIN);
    expect(snapshot.locked).toBe(false);
  });

  it('routes inbound wallet messages to the default agent', async () => {
    const broker = makeBroker();
    await broker.start();
    await broker.startPairing();
    await waitFor(() => eventsOf('connection.connected').length > 0);

    wallet!.peerTransport!.send('hello from the wallet');

    await waitFor(() => eventsOf('message.inbound').length > 0);
    const inbound = eventsOf('message.inbound')[0]!.data as ControlEvents['message.inbound'];
    expect(inbound.agent).toBe('openclaw');
    expect(inbound.channel).toBe('control');
    expect(inbound.payload).toBe('hello from the wallet');
    expect(inbound.controllerDid).toBe(STUB_CONTROLLER_DID);
    expect(inbound.requestId).toBe(broker.snapshot().requestId);
  });

  it('send() round-trips an outbound frame to the wallet', async () => {
    const broker = makeBroker();
    await broker.start();
    await broker.startPairing();
    await waitFor(() => eventsOf('connection.connected').length > 0);

    const result = await broker.send('openclaw', 'control', 'hello wallet');
    expect(result).toEqual({ delivered: true });

    await waitFor(() => wallet!.received.length > 0);
    expect(wallet!.received).toContain('hello wallet');
  });

  it('serviceDid() is non-null and stable across broker instances on the same dirs', async () => {
    const broker = makeBroker();
    await broker.start();
    const first = broker.serviceDid();
    expect(first).not.toBeNull();
    expect(first).toMatch(/^did:key:z/);
    expect(keystore.keys.find((key) => key.id === SERVICE_KEY_ID)).toBeDefined();

    const secondKeystore = fixture.create();
    const secondBroker = makeBroker(secondKeystore);
    await secondBroker.start();
    expect(secondBroker.serviceDid()).toBe(first);
  });

  it('stores the wallet-issued agent identity key in the keystore', async () => {
    const broker = makeBroker();
    await broker.start();
    await broker.startPairing();
    await waitFor(() => eventsOf('connection.connected').length > 0);

    // The wallet-granted key lands next to the service key, under the agent DID,
    // with the public key the wallet issued (so its DID is reproducible).
    await waitFor(() => keystore.keys.length > 1);
    const agentKey = keystore.keys.find((key) => key.id !== SERVICE_KEY_ID);
    expect(agentKey?.id).toMatch(/^did:key:z/);
    expect(Buffer.from(agentKey?.publicKey ?? new Uint8Array()).toString('base64')).toBe(
      AGENT_KEY.publicKey,
    );

    // Non-extractable, but usable: the daemon can sign as that identity.
    const signature = await keystore.keystore.sign(agentKey!.id, new Uint8Array([1, 2, 3]));
    expect(signature).toHaveLength(64);
  });

  it('hard-fails the session (never acknowledging the grant) when the identity key cannot be persisted', async () => {
    // An OS keychain that dies AFTER startup: the service key persists fine,
    // then every access fails — e.g. the Secret Service daemon went away.
    const entries = new Map<string, string>();
    let keychainBroken = false;
    const flakyKeyring: KeyringBinding = {
      get: (account) => {
        if (keychainBroken) throw new Error('Secret Service unreachable');
        return entries.get(account) ?? null;
      },
      set: (account, secret) => {
        if (keychainBroken) throw new Error('Secret Service unreachable');
        entries.set(account, secret);
      },
      delete: (account) => entries.delete(account),
    };
    const store = fixture.create({ keyring: flakyKeyring });
    const broker = makeBroker(store);
    await broker.start(); // service key lands while the keychain still works
    keychainBroken = true;

    await broker.startPairing();
    await waitFor(() => eventsOf('connection.disconnected').length > 0);

    // The session failed loudly, naming the real cause…
    const reason = (
      eventsOf('connection.disconnected')[0]!.data as ControlEvents['connection.disconnected']
    ).reason;
    expect(reason).toContain('failed to persist the wallet-issued identity key');

    // …the grant was never acknowledged (no `connected` claiming an identity)…
    expect(eventsOf('connection.connected')).toHaveLength(0);
    expect(broker.snapshot().state).not.toBe('connected');

    // …and no identity metadata was persisted, so the next session
    // re-bootstraps instead of "reusing" an identity whose key was lost.
    const persisted = loadAc2State();
    expect(persisted.identity).toBeUndefined();
    const connections = Object.values(persisted.connections ?? {});
    expect(connections.every((connection) => connection.identity === undefined)).toBe(true);
  });

  it('send() returns delivered:false before a connection exists', async () => {
    const broker = makeBroker();
    await broker.start();

    expect(await broker.send('openclaw', 'control', 'too early')).toEqual({ delivered: false });
    expect(await broker.send('openclaw', 'stream', 'too early')).toEqual({ delivered: false });
    expect(broker.snapshot().state).toBe('idle');
  });

  it('locks the session when a different controller connects, but still allows agent.send while dropping inbound traffic', async () => {
    const BOUND_CONTROLLER_DID = 'did:key:zBoundWallet';
    saveAc2State({
      identity: { agentDid: 'did:key:zBoundAgent', controllerDid: BOUND_CONTROLLER_DID, publicKey: 'unused' },
    });

    let controllerWallet: ControllerWalletProvider | undefined;
    const broker = makeBroker(keystore, (requestId?: string) => {
      controllerWallet = new ControllerWalletProvider('zOtherWallet', {
        origin: ORIGIN,
        ...(requestId ? { requestId } : {}),
      });
      return controllerWallet;
    });
    await broker.start();
    await broker.startPairing();
    await waitFor(() => eventsOf('connection.connected').length > 0);

    const connectedEvent = eventsOf('connection.connected')[0]!
      .data as ControlEvents['connection.connected'];
    expect(connectedEvent.locked).toBe(true);
    expect(connectedEvent.identityGranted).toBe(false);
    expect(connectedEvent.agentDid).toBeNull();
    expect(broker.snapshot().locked).toBe(true);

    // Inbound wallet traffic is dropped while locked.
    controllerWallet!.peerTransport!.send('hello from the wrong wallet');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(eventsOf('message.inbound')).toHaveLength(0);

    // But `send()` still works, so the agent can push a "not registered" notice.
    const result = await broker.send('openclaw', 'control', 'you are not registered');
    expect(result).toEqual({ delivered: true });
    await waitFor(() => controllerWallet!.received.length > 0);
    expect(controllerWallet!.received).toContain('you are not registered');
  });

  it('reuses the persisted agent identity when the same controller reconnects', async () => {
    const STORED_AGENT_DID = 'did:key:zReusedAgent';
    const STORED_CONTROLLER_DID = 'did:key:zSameWallet';
    saveAc2State({
      identity: { agentDid: STORED_AGENT_DID, controllerDid: STORED_CONTROLLER_DID, publicKey: 'AAAA' },
    });

    const broker = makeBroker();
    await broker.start();
    await broker.startPairing();
    await waitFor(() => eventsOf('connection.connected').length > 0);

    const connectedEvent = eventsOf('connection.connected')[0]!
      .data as ControlEvents['connection.connected'];
    expect(connectedEvent.locked).toBe(false);
    expect(connectedEvent.identityGranted).toBe(true);
    expect(connectedEvent.agentDid).toBe(STORED_AGENT_DID);
    expect(broker.snapshot().locked).toBe(false);
  });

  describe('reconnect loop throttling', () => {
    /** Build a broker over `provider`, collecting its log lines. */
    const makeFailingBroker = (
      provider: Ac2ChannelProvider,
      logs: string[],
    ): ConnectionBroker => {
      const broker = createConnectionBroker({
        providerFactory: () => provider,
        origin: ORIGIN,
        keystore,
        emit,
        log: (line: string) => logs.push(line),
      });
      brokers.push(broker);
      return broker;
    };

    it('does not rebuild pairing in a storm when a session dies immediately after a SUCCESSFUL beginPairing', async () => {
      // Regression: the loop only slept when `beginPairing()` THREW, so a
      // pairing that was built fine and then died at once re-cycled with zero
      // delay — opening (and abandoning) a fresh signaling socket every few
      // milliseconds. The server saw ~45 orphaned sessions in ~2s.
      const provider = new FailingPairingProvider();
      const broker = makeFailingBroker(provider, []);
      await broker.start();
      await broker.startPairing();

      await new Promise((resolve) => setTimeout(resolve, 500));

      // The initial build plus at most one more inside the 500ms window (the
      // first backoff is 2s). Unthrottled, this was in the hundreds.
      expect(provider.built).toBeLessThanOrEqual(2);
    });

    it('drops to a slow retry cadence after repeated failures WITHOUT ever stalling', async () => {
      const provider = new FailingPairingProvider();
      const logs: string[] = [];
      const broker = makeFailingBroker(provider, logs);
      // Start before faking timers so the keystore's real I/O completes.
      await broker.start();

      vi.useFakeTimers();
      try {
        await broker.startPairing();
        // Well past the full 2s→30s ramp plus the first cooldown waits.
        await vi.advanceTimersByTimeAsync(600_000);

        // Escalated, but bounded: the 2s→30s ramp gives 8 builds in the first
        // ~2 minutes, after which the 5-minute tier adds roughly one more per
        // 5 minutes. Unthrottled this was in the thousands.
        const afterTenMinutes = provider.built;
        expect(afterTenMinutes).toBeGreaterThanOrEqual(8);
        expect(afterTenMinutes).toBeLessThanOrEqual(12);
        expect(logs.some((line) => line.includes('slowing reconnect attempts'))).toBe(true);

        // Never a dead end: the daemon is headless, so a terminal give-up
        // would leave the wallet with no way back in. The loop must still be
        // trying — both in state and in fresh attempts.
        expect(broker.snapshot().state).toBe('reconnecting');
        await vi.advanceTimersByTimeAsync(600_000);
        expect(provider.built).toBeGreaterThan(afterTenMinutes);
      } finally {
        vi.useRealTimers();
      }

      // …and the degraded cadence is surfaced to clients, not just logged.
      const reasons = eventsOf('connection.disconnected').map(
        (e) => (e.data as ControlEvents['connection.disconnected']).reason,
      );
      expect(reasons.some((reason) => reason.includes('pairing degraded after'))).toBe(true);
    });

    it('retries immediately when an explicit pair request arrives during a backoff', async () => {
      // The slow tier must never feel like a stall: asking to pair collapses
      // the outstanding delay instead of making the caller wait it out.
      const provider = new FailingPairingProvider();
      const broker = makeFailingBroker(provider, []);
      await broker.start();

      vi.useFakeTimers();
      try {
        await broker.startPairing();
        // Sit inside a backoff window (the first is 2s, so 500ms is well in).
        await vi.advanceTimersByTimeAsync(500);
        const beforeKick = provider.built;

        await broker.startPairing();
        await vi.advanceTimersByTimeAsync(10);
        expect(provider.built).toBeGreaterThan(beforeKick);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('reports no granted identity when the wallet rejects the bootstrap KeyRequest', async () => {
    const broker = makeBroker(keystore, (requestId?: string) => {
      return new DenyingWalletProvider({
        origin: ORIGIN,
        ...(requestId ? { requestId } : {}),
      });
    });
    await broker.start();
    await broker.startPairing();
    await waitFor(() => eventsOf('connection.connected').length > 0);

    const connectedEvent = eventsOf('connection.connected')[0]!
      .data as ControlEvents['connection.connected'];
    expect(connectedEvent.locked).toBe(false);
    expect(connectedEvent.identityGranted).toBe(false);
    expect(connectedEvent.agentDid).toBeNull();
    expect(broker.snapshot().locked).toBe(false);
  });
});
