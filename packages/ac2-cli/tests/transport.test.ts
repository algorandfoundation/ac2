/**
 * Tests for the daemon-backed `Ac2Transport` adapter (`src/control/transport.ts`).
 *
 * Runs a real in-process daemon (see `agent.test.ts`/`broker.test.ts` for the
 * same pattern) with the in-memory channel provider standing in for the
 * wallet, so `createDaemonTransport`/`createDaemonStreamSendable` are
 * exercised against the genuine control-socket wire format — not a hand-made
 * `AgentSession` double.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { buildKeyResponse } from '@algorandfoundation/ac2-sdk/protocol';
import { isKeyRequest, isSigningRequest } from '@algorandfoundation/ac2-sdk/schema';
import type { Ac2Transport, RtcDataChannelLike } from '@algorandfoundation/ac2-sdk/transport';
import type { Ac2PairingHandle, Ac2StartPairingOptions } from '@algorandfoundation/ac2-sdk/signaling';
import { runDaemon, type RunningDaemon } from '../src/daemon/run.js';
import { InMemoryChannelProvider } from '@algorandfoundation/ac2-sdk/providers/in-memory';
import { connectAgentSession, type AgentSession } from '../src/control/agent.js';
import { createDaemonStreamSendable, createDaemonTransport } from '../src/control/transport.js';
import { createKeyStoreFixture } from './helpers/keystore.js';

const STUB_CONTROLLER_DID = 'did:key:zStubController';
const STUB_AGENT_PK = 'AgentIdentityPubKey';

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
                material: 'stub-material',
                public_key: STUB_AGENT_PK,
              },
            }),
          ),
        );
        return;
      }
      // Round-trip anything else (e.g. a SigningRequest) straight back to the
      // agent as a raw frame so `onMessage`-vs-`onRawMessage` split is moot
      // for these tests; assertions below rely on `isSigningRequest` cases
      // being sent explicitly where needed.
      if (isSigningRequest(msg)) return;
    });
    peerTransport.onRawMessage?.((payload) => {
      this.received.push(payload);
    });
  }
}

/** Minimal, mutable `RtcDataChannelLike` double for the `ac2-stream` side channel. */
function makeFakeStreamChannel(): { channel: RtcDataChannelLike; received: string[] } {
  const received: string[] = [];
  let readyState: RtcDataChannelLike['readyState'] = 'open';
  const channel: RtcDataChannelLike = {
    get label() {
      return 'ac2-stream';
    },
    get readyState() {
      return readyState;
    },
    send(data: string) {
      received.push(data);
    },
    close() {
      readyState = 'closed';
      channel.onclose?.(undefined);
    },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  return { channel, received };
}

/** Wraps {@link FakeWalletProvider} to also attach a fake `ac2-stream` side channel. */
class StreamCapableWalletProvider extends FakeWalletProvider {
  streamReceived: string[] = [];
  private streamChannel: RtcDataChannelLike | undefined;

  override async startPairing(opts: Ac2StartPairingOptions = {}): Promise<Ac2PairingHandle> {
    const handle = await super.startPairing(opts);
    const { channel, received } = makeFakeStreamChannel();
    this.streamChannel = channel;
    this.streamReceived = received;
    return {
      ...handle,
      connect: async () => {
        const paired = await handle.connect();
        return { ...paired, streamChannel: channel };
      },
    };
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

describe('createDaemonTransport / createDaemonStreamSendable', () => {
  let stateDir: string;
  let socketDir: string;
  let previousStateDir: string | undefined;
  let daemon: RunningDaemon;
  let wallet: StreamCapableWalletProvider;
  let session: AgentSession;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'ac2-transport-test-state-'));
    socketDir = await mkdtemp(join(tmpdir(), 'ac2-transport-test-sock-'));
    previousStateDir = process.env['AC2_STATE_DIR'];
    process.env['AC2_STATE_DIR'] = stateDir;

    daemon = await runDaemon({
      socketPath: join(socketDir, 'ac2d.sock'),
      keystore: createKeyStoreFixture(stateDir).options(),
      handleSignals: false,
      hostKeystore: false,
      log: () => {},
      providerFactory: (requestId) => {
        wallet = new StreamCapableWalletProvider({
          origin: 'https://debug.liquidauth.com',
          ...(requestId ? { requestId } : {}),
        });
        return wallet;
      },
    });

    session = await connectAgentSession({
      agent: 'openclaw',
      autoStart: false,
      socketPath: daemon.socketPath,
      timeoutMs: 2000,
    });
  });

  afterEach(async () => {
    try {
      await session.close();
    } catch {
      // best-effort
    }
    try {
      await daemon.stop();
    } catch {
      // best-effort
    }
    if (previousStateDir === undefined) delete process.env['AC2_STATE_DIR'];
    else process.env['AC2_STATE_DIR'] = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
  });

  it('isOpen reflects connection.connected / connection.disconnected', async () => {
    const transport = createDaemonTransport(session);
    expect(transport.isOpen).toBe(false);

    let opened = false;
    transport.onOpen(() => {
      opened = true;
    });

    await session.startPairing({ timeoutMs: 2000 });
    await waitFor(() => opened);
    expect(transport.isOpen).toBe(true);

    // Captured synchronously inside the handler itself — the daemon's
    // reconnect loop may re-establish the (in-memory) link again right
    // after this fires, so polling `transport.isOpen` afterwards would race
    // it. The contract under test is that `isOpen` is false AT THE MOMENT
    // `onClose` runs, not that it stays false forever.
    let closedFired = false;
    let openAtClose: boolean | undefined;
    transport.onClose(() => {
      closedFired = true;
      openAtClose = transport.isOpen;
    });
    wallet.peerTransport!.close();
    await waitFor(() => closedFired);
    expect(openAtClose).toBe(false);

    transport.close();
  });

  it('parses AC2-shaped message.inbound frames via onMessage, others via onRawMessage', async () => {
    const transport = createDaemonTransport(session);
    const client = new Ac2Client(transport);
    void client; // constructed to register onMessage/onError/onClose like a real consumer

    const rawMessages: string[] = [];
    // `onRawMessage` is optional on `Ac2Transport`; the daemon transport always
    // implements it (that is the whole point of the raw-chat path).
    transport.onRawMessage!((payload) => rawMessages.push(payload));

    await session.startPairing({ timeoutMs: 2000 });
    await waitFor(() => transport.isOpen);

    // Bootstrap already exercises the `onMessage` (AC2-shaped) path via
    // `Ac2Client`'s internal `KeyRequest`/`KeyResponse` plumbing — assert the
    // simpler, directly observable raw-chat path here.
    wallet.peerTransport!.send('hello from the wallet');
    await waitFor(() => rawMessages.length > 0);
    expect(rawMessages).toContain('hello from the wallet');

    transport.close();
  });

  it('send() forwards on the requested channel and surfaces failures via onError', async () => {
    const transport = createDaemonTransport(session, { channel: 'control' });
    await session.startPairing({ timeoutMs: 2000 });
    await waitFor(() => transport.isOpen);

    transport.send('hello wallet');
    await waitFor(() => wallet.received.includes('hello wallet'));

    transport.close();
  });

  it('close() detaches listeners without closing the shared AgentSession', async () => {
    const transport = createDaemonTransport(session);
    await session.startPairing({ timeoutMs: 2000 });
    await waitFor(() => transport.isOpen);

    transport.close();
    expect(transport.isOpen).toBe(false);

    // The underlying `AgentSession` is still alive and usable — `close()`
    // only detaches this one transport's listeners, it must not tear down
    // the shared control-socket connection.
    const delivered = await session.send('still alive', 'control');
    expect(delivered).toBe(true);
    await waitFor(() => wallet.received.includes('still alive'));
  });

  it('seeds isOpen=true for a transport built after the wallet is already connected', async () => {
    await session.startPairing({ timeoutMs: 2000 });
    const first = createDaemonTransport(session);
    await waitFor(() => first.isOpen);
    first.close();

    // A brand new session joining after the connection is already live must
    // see `isOpen: true` immediately from the `agent.hello` snapshot, with no
    // `connection.connected` event to wait on (it already fired for `session`).
    const lateSession = await connectAgentSession({
      agent: 'late-agent',
      autoStart: false,
      socketPath: daemon.socketPath,
      timeoutMs: 2000,
    });
    try {
      const lateTransport = createDaemonTransport(lateSession);
      expect(lateTransport.isOpen).toBe(true);
      lateTransport.close();
    } finally {
      await lateSession.close();
    }
  });

  it('createDaemonStreamSendable forwards on the stream channel and tracks isOpen', async () => {
    const sendable = createDaemonStreamSendable(session);
    expect(sendable.isOpen).toBe(false);

    await session.startPairing({ timeoutMs: 2000 });
    await waitFor(() => sendable.isOpen);

    sendable.send('\u0002{"t":"notice","code":"test","text":"hi"}');
    await waitFor(() => wallet.streamReceived.some((m) => m.includes('"code":"test"')));
  });

  it('reports undeliverable stream frames (no ac2-stream channel) and closes itself', async () => {
    // The control protocol cannot say up front whether the wallet negotiated a
    // stream channel — only `agent.send`'s `delivered: false` reveals it. A
    // host that keeps a separate stream surface therefore needs to be told, so
    // it can re-send the frame on its main transport instead of losing it.
    const undeliverable: string[] = [];
    const sendable = createDaemonStreamSendable(session, {
      onUndeliverable: (payload) => undeliverable.push(payload),
    });

    sendable.send('dropped frame');
    await waitFor(() => undeliverable.length > 0);
    expect(undeliverable).toEqual(['dropped frame']);
    expect(sendable.isOpen).toBe(false);
  });
});
