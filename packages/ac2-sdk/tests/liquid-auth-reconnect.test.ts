/**
 * Regression tests for the "keep the signaling socket alive across reconnects"
 * behavior. The mobile wallet keeps ONE signaling socket and just re-runs its
 * WebRTC offer when it reopens; the agent must mirror that — an ordinary peer
 * drop must tear down ONLY the p2p peer and KEEP the signaling socket connected
 * so the caller can re-arm `connect()` and answer the returning wallet in place
 * (no presence churn, no QR rescan, no manual Reconnect). Only a genuinely dead
 * socket (`dispose`) fully tears the signaling connection down.
 *
 * The Liquid Auth `SignalClient` and the `socket.io-client` factory are mocked
 * so `startPairing`/`connect` can run headless: the fakes let us assert exactly
 * which teardown calls happen on `close()` vs `dispose()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const clientCloseSpy = vi.fn<(disconnect?: boolean) => void>();
  const socketCloseSpy = vi.fn<() => void>();
  const socketDisconnectSpy = vi.fn<() => void>();
  const socketConnectSpy = vi.fn<() => void>();
  const state = {
    lastSocket: null as any,
    lastClient: null as any,
    lastIoOpts: null as any,
    peerCalls: 0,
    /** The `requestId` each `peer()` attempt was invoked with, in call order. */
    peerRequestIds: [] as string[],
    peerCloseSpies: [] as Array<ReturnType<typeof vi.fn>>,
    // When set, the fake `peer()` parks on this promise after creating its
    // `peerClient` — mimicking the real SDK awaiting the wallet's link/offer —
    // so tests can interleave events with an in-flight negotiation. Consumed
    // once: the attempt that finds the gate takes it, so a re-armed attempt
    // runs through.
    peerGate: null as Promise<void> | null,
  };
  return { clientCloseSpy, socketCloseSpy, socketDisconnectSpy, socketConnectSpy, state };
});

vi.mock('socket.io-client', () => ({
  io: (_url: string, opts: unknown) => {
    H.state.lastIoOpts = opts;
    const listeners: Record<string, Array<(...args: any[]) => void>> = {};
    const socket = {
      connected: true,
      // `attachSessionCookiePersistence` pokes `socket.io?.engine?.transport`;
      // an empty object keeps its optional-chaining guards happy.
      io: {} as any,
      on(ev: string, fn: (...args: any[]) => void) {
        (listeners[ev] ??= []).push(fn);
      },
      off(ev: string, fn?: (...args: any[]) => void) {
        if (!fn) delete listeners[ev];
        else listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
      },
      emit(ev: string, ...args: any[]) {
        for (const fn of [...(listeners[ev] ?? [])]) fn(...args);
      },
      close() {
        this.connected = false;
        H.socketCloseSpy();
      },
      disconnect() {
        this.connected = false;
        H.socketDisconnectSpy();
      },
      connect() {
        H.socketConnectSpy();
        this.connected = true;
        this.emit('connect');
      },
    };
    H.state.lastSocket = socket;
    return socket;
  },
}));

vi.mock('@algorandfoundation/liquid-client/signal', () => {
  class FakeSignalClient {
    socket: any;
    peerClient: any;
    authenticated = false;
    requestId: string | undefined;
    private _listeners: Record<string, Array<(...args: any[]) => void>> = {};

    static generateRequestId(): string {
      return 'req-test';
    }

    constructor(_url: string, opts: { socket: any }) {
      this.socket = opts.socket;
      H.state.lastClient = this;
      // Mirror the real SDK: a socket `connect` surfaces as a client `connect`
      // (this is what `awaitSignalConnect` waits on).
      this.socket.on('connect', () => this.emit('connect'));
    }

    on(ev: string, fn: (...args: any[]) => void): void {
      (this._listeners[ev] ??= []).push(fn);
    }

    off(ev: string, fn?: (...args: any[]) => void): void {
      if (!fn) delete this._listeners[ev];
      else this._listeners[ev] = (this._listeners[ev] ?? []).filter((f) => f !== fn);
    }

    emit(ev: string, ...args: any[]): void {
      for (const fn of [...(this._listeners[ev] ?? [])]) fn(...args);
    }

    deepLink(id: string): string {
      return `liquid://example/?requestId=${id}`;
    }

    close(disconnect = false): void {
      H.clientCloseSpy(disconnect);
      if (disconnect) this.socket.disconnect();
    }

    async peer(
      requestId: string,
      _type: string,
      _config: unknown,
      opts: { dataChannels: Record<string, unknown> },
    ): Promise<any> {
      H.state.peerCalls += 1;
      H.state.peerRequestIds.push(requestId);
      // Mirror the real `link()` latch: it refuses to run while a requestId is
      // still in progress, and only clears it when the wallet's link ack
      // arrives — which never happens for a negotiation stranded by a
      // signaling drop (socket.io discards the pending ack).
      if (this.requestId !== undefined) throw new Error('Request is in process');
      this.requestId = requestId;
      const peerCloseSpy = vi.fn();
      this.peerClient = { close: peerCloseSpy };
      H.state.peerCloseSpies.push(peerCloseSpy);
      const gate = H.state.peerGate;
      if (gate) {
        H.state.peerGate = null;
        // Park like the real `peer()` does while awaiting the wallet's
        // link/offer, then dereference `peerClient` exactly like the real SDK
        // (`this.peerClient.onicecandidate = …`) — a teardown that nulled it
        // mid-flight reproduces the production TypeError.
        await gate;
        if (!this.peerClient) {
          throw new TypeError("Cannot set properties of undefined (setting 'onicecandidate')");
        }
      }
      delete this.requestId;
      this.authenticated = true;
      const channels: Record<string, any> = {};
      for (const label of Object.keys(opts?.dataChannels ?? {})) {
        const ch = {
          label,
          readyState: 'open' as const,
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
          send() {},
          close() {
            (this as any).readyState = 'closed';
          },
        };
        channels[label] = ch;
        // The real SDK surfaces every negotiated channel via `data-channel`.
        this.emit('data-channel', ch);
      }
      return channels['ac2-v1'];
    }
  }
  return { SignalClient: FakeSignalClient };
});

// Import AFTER the mocks are registered.
const { LiquidAuthChannelProvider } = await import('../src/providers/liquid-auth.js');

async function startAndConnect(): Promise<{
  handle: Awaited<ReturnType<InstanceType<typeof LiquidAuthChannelProvider>['startPairing']>>;
  paired: Awaited<
    ReturnType<
      Awaited<ReturnType<InstanceType<typeof LiquidAuthChannelProvider>['startPairing']>>['connect']
    >
  >;
}> {
  const provider = new LiquidAuthChannelProvider({ origin: 'https://example.test' });
  const handlePromise = provider.startPairing({ timeoutMs: 5_000 });
  // The socket is created after `ensureWebRtcPolyfill()`; once it exists, emit
  // `connect` so `startPairing`'s `await waitForConnect` resolves.
  await vi.waitFor(() => {
    expect(H.state.lastSocket).toBeTruthy();
  });
  H.state.lastSocket.emit('connect');
  const handle = await handlePromise;
  const paired = await handle.connect();
  return { handle, paired };
}

describe('LiquidAuthChannelProvider — socket-preserving reconnect', () => {
  beforeEach(() => {
    // A polyfilled WebRTC global short-circuits the native `@roamhq/wrtc` import.
    (globalThis as any).RTCPeerConnection ??= class {};
    H.clientCloseSpy.mockClear();
    H.socketCloseSpy.mockClear();
    H.socketDisconnectSpy.mockClear();
    H.socketConnectSpy.mockClear();
    H.state.lastSocket = null;
    H.state.lastClient = null;
    H.state.lastIoOpts = null;
    H.state.peerCalls = 0;
    H.state.peerRequestIds = [];
    H.state.peerCloseSpies = [];
    H.state.peerGate = null;
  });

  it('creates the signaling socket polling-first (so the server establishes a session)', async () => {
    await startAndConnect();
    // MUST be polling-first (the socket.io default), then upgrade to websocket.
    // The Liquid Auth server creates and persists the Express session — and
    // sets the session cookie — during the initial HTTP long-polling handshake.
    // That session is what the gateway's `link` handler looks up before joining
    // the socket into the `requestId` presence room; a websocket-first socket
    // skips the handshake, so the agent is never counted as present and the
    // wallet tears the pairing down as "peer went offline". (Regression test
    // for the live pairing failure; see the transports comment in the provider.)
    expect(H.state.lastIoOpts?.transports).toEqual(['polling', 'websocket']);
  });

  it('close() tears down ONLY the peer and keeps the signaling socket connected', async () => {
    const { handle, paired } = await startAndConnect();
    expect(H.state.peerCalls).toBe(1);

    await paired.close();

    // Peer torn down…
    expect(H.state.peerCloseSpies[0]).toHaveBeenCalledTimes(1);
    // …but the signaling socket is left ALIVE for an in-place re-link.
    expect(H.clientCloseSpy).not.toHaveBeenCalled();
    expect(H.socketDisconnectSpy).not.toHaveBeenCalled();
    expect(H.socketCloseSpy).not.toHaveBeenCalled();
    expect(handle.isSignalingAlive?.()).toBe(true);
  });

  it('surfaces a control-transport close to the consumer without dropping the socket', async () => {
    const { handle, paired } = await startAndConnect();
    let closed = 0;
    paired.transport.onClose(() => {
      closed += 1;
    });

    await paired.close();

    expect(closed).toBe(1); // consumer notified (session loop wakes up)…
    expect(handle.isSignalingAlive?.()).toBe(true); // …socket still usable.
  });

  it('connect() is re-runnable on the SAME socket (answers a returning wallet in place)', async () => {
    const { handle, paired } = await startAndConnect();
    await paired.close();

    // Re-arm on the same live socket — no new socket is created.
    const socketBefore = H.state.lastSocket;
    const paired2 = await handle.connect();

    expect(H.state.peerCalls).toBe(2);
    expect(H.state.lastSocket).toBe(socketBefore);
    expect(paired2.transport).toBeDefined();
    expect(handle.isSignalingAlive?.()).toBe(true);

    await paired2.close();
  });

  it('dispose() fully tears down the signaling socket', async () => {
    const { handle, paired } = await startAndConnect();
    await paired.close();

    await handle.dispose?.();

    expect(H.clientCloseSpy).toHaveBeenCalledWith(true);
    expect(H.socketCloseSpy).toHaveBeenCalled();
    expect(handle.isSignalingAlive?.()).toBe(false);
  });

  it('tears down a LIVE connection (peer-only) when presence reports the peer went offline', async () => {
    const { handle, paired } = await startAndConnect();
    // The wallet linked, arming presence-driven teardown.
    H.state.lastClient.emit('link-message', { wallet: 'W' });
    let closed = 0;
    paired.transport.onClose(() => {
      closed += 1;
    });

    // The phone closed: the server broadcasts a drop to a single device while
    // our own signaling link is still healthy — a real departure.
    H.state.lastSocket.emit('presence', {
      requestId: 'req-test',
      deviceCount: 1,
      online: true,
    });

    await vi.waitFor(() => {
      expect(H.state.peerCloseSpies[0]).toHaveBeenCalledTimes(1);
    });
    // Consumer is notified so the re-pair loop wakes and re-arms…
    expect(closed).toBe(1);
    // …but the signaling socket is KEPT alive for an in-place re-link.
    expect(H.clientCloseSpy).not.toHaveBeenCalled();
    expect(H.socketDisconnectSpy).not.toHaveBeenCalled();
    expect(handle.isSignalingAlive?.()).toBe(true);
  });

  it('tears the stale peer down when the wallet re-offers while presence still reports it live', async () => {
    // The failure this fixes: after a long background the wallet's native
    // service keeps its signaling socket in the room (so presence never drops
    // to one device) while its WebRTC path is dead. Nothing tore our peer
    // down, and the SDK only arms an answer listener INSIDE `peer()`, so the
    // wallet's renegotiation offers landed on a socket with nothing listening
    // — "Reconnecting…" forever, and not a line in the agent log. An inbound
    // offer while we still believe we are connected is proof the peer
    // restarted, so tear it down and let the caller re-arm in place.
    const { handle, paired } = await startAndConnect();
    H.state.lastClient.emit('link-message', { wallet: 'W' });
    let closed = 0;
    paired.transport.onClose(() => {
      closed += 1;
    });

    H.state.lastSocket.emit('offer-description', 'v=0 (the wallet restarted)');

    await vi.waitFor(() => {
      expect(H.state.peerCloseSpies[0]).toHaveBeenCalledTimes(1);
    });
    expect(closed).toBe(1);
    // The socket is untouched: the very next offer is answered on it in place.
    expect(H.clientCloseSpy).not.toHaveBeenCalled();
    expect(H.socketDisconnectSpy).not.toHaveBeenCalled();
    expect(handle.isSignalingAlive?.()).toBe(true);

    const paired2 = await handle.connect();
    expect(H.state.peerCalls).toBe(2);
    await paired2.close();
  });

  it('does NOT act on the offer that an armed negotiation is itself waiting for', async () => {
    // While `peer()` is parked awaiting the wallet, its own one-shot listener
    // must consume the offer; tearing down here would null `peerClient` under
    // the pending handshake (the crash the presence rule already guards).
    const { handle, paired } = await startAndConnect();
    H.state.lastClient.emit('link-message', { wallet: 'W' });
    await paired.close();

    let releaseWallet!: () => void;
    H.state.peerGate = new Promise<void>((resolve) => {
      releaseWallet = resolve;
    });
    const reconnect = handle.connect();
    await vi.waitFor(() => {
      expect(H.state.peerCalls).toBe(2);
    });

    H.state.lastSocket.emit('offer-description', 'v=0 (the awaited offer)');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(H.state.peerCloseSpies[1]).not.toHaveBeenCalled();
    expect(H.state.lastClient.peerClient).toBeTruthy();

    releaseWallet();
    const paired2 = await reconnect;
    expect(paired2.transport).toBeDefined();
    await paired2.close();
  });

  it('does NOT tear down an in-flight re-link negotiation on a presence drop', async () => {
    // Regression for the production crash: the wallet linked once, the session
    // dropped, and `connect()` was re-armed — parked inside `peer()` awaiting
    // the wallet's return. A presence broadcast still reporting a single
    // device then invoked the (stale) close, whose `teardownPeer` nulled
    // `SignalClient.peerClient` under the pending handshake; when the wallet
    // re-linked, `peer()` resumed and crashed with
    // "Cannot set properties of undefined (setting 'onicecandidate')" /
    // "Cannot read properties of undefined (reading 'setRemoteDescription')",
    // failing the wallet's first re-link attempt (`[ac2] Pairing failed`).
    const { handle, paired } = await startAndConnect();
    H.state.lastClient.emit('link-message', { wallet: 'W' });
    await paired.close();

    // Re-arm on the same socket, holding the negotiation in flight (the wallet
    // is still away).
    let releaseWallet!: () => void;
    H.state.peerGate = new Promise<void>((resolve) => {
      releaseWallet = resolve;
    });
    const reconnect = handle.connect();
    await vi.waitFor(() => {
      expect(H.state.peerCalls).toBe(2);
    });

    // The server still reports just this agent — the drop must NOT tear down
    // the armed negotiation (it is exactly what answers the returning wallet).
    H.state.lastSocket.emit('presence', {
      requestId: 'req-test',
      deviceCount: 1,
      online: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(H.state.peerCloseSpies[1]).not.toHaveBeenCalled();
    expect(H.state.lastClient.peerClient).toBeTruthy();

    // The wallet returns: the parked handshake resolves in place — no TypeError.
    releaseWallet();
    H.state.peerGate = null;
    const paired2 = await reconnect;
    expect(paired2.transport).toBeDefined();
    expect(handle.isSignalingAlive?.()).toBe(true);
    await paired2.close();
  });

  it('re-arms the handshake on the same socket (same requestId) when signaling drops mid-negotiation', async () => {
    // The production hang: parked in `peer()` awaiting the wallet's re-link, a
    // ping-timeout blip discards the pending `link` ack (socket.io `_clearAcks`)
    // and kills the server-side subscription — socket.io reconnects fine, but
    // the rendezvous is gone and the daemon waited on it forever, deaf to every
    // one of the wallet's retries until process restart.
    const { handle, paired } = await startAndConnect();
    H.state.lastClient.emit('link-message', { wallet: 'W' });
    await paired.close();

    let releaseStranded!: () => void;
    H.state.peerGate = new Promise<void>((resolve) => {
      releaseStranded = resolve;
    });
    const reconnect = handle.connect();
    await vi.waitFor(() => {
      expect(H.state.peerCalls).toBe(2);
    });

    const socketBefore = H.state.lastSocket;
    socketBefore.connected = false;
    socketBefore.emit('disconnect', 'transport close');
    socketBefore.connect();

    const paired2 = await reconnect;
    // Re-armed: a THIRD `peer()` attempt answered the wallet…
    expect(H.state.peerCalls).toBe(3);
    // …on the SAME socket — no full teardown, no fresh pairing handle…
    expect(H.state.lastSocket).toBe(socketBefore);
    expect(H.clientCloseSpy).not.toHaveBeenCalled();
    expect(handle.isSignalingAlive?.()).toBe(true);
    // …and with the SAME pairing requestId: the identity only rotates when the
    // user forgets the pairing, never behind their back on a reconnect.
    expect(H.state.peerRequestIds[2]).toBe(H.state.peerRequestIds[1]);

    await paired2.close();
    releaseStranded();
  });

  it('does NOT tear down a live connection when a presence drop coincides with a signaling blip', async () => {
    const { handle, paired } = await startAndConnect();
    H.state.lastClient.emit('link-message', { wallet: 'W' });
    let closed = 0;
    paired.transport.onClose(() => {
      closed += 1;
    });

    // OUR OWN signaling socket blips (server restart) — signaling is now
    // unstable, so a transient recount to a single device is an artifact, not a
    // departure, and must not restart a healthy p2p connection.
    H.state.lastSocket.emit('disconnect');
    H.state.lastSocket.emit('presence', {
      requestId: 'req-test',
      deviceCount: 1,
      online: true,
    });

    // Give any async close a tick to (not) happen.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(H.state.peerCloseSpies[0]).not.toHaveBeenCalled();
    expect(closed).toBe(0);
    expect(handle.isSignalingAlive?.()).toBe(true);
  });
});

describe('LiquidAuthChannelProvider — signaling diagnostics', () => {
  beforeEach(() => {
    (globalThis as any).RTCPeerConnection ??= class {};
    H.state.lastSocket = null;
    H.state.lastClient = null;
    H.state.peerCalls = 0;
    H.state.peerRequestIds = [];
    H.state.peerCloseSpies = [];
    H.state.peerGate = null;
  });

  it('logs every signaling reconnect', async () => {
    // Production logs showed long runs of disconnect lines with no matching
    // connect line, making a recovered blip indistinguishable from a permanent
    // outage. The provider now logs the reconnect alongside the disconnect.
    const lines: string[] = [];
    const provider = new LiquidAuthChannelProvider({
      origin: 'https://example.test',
      logger: (_level, line) => lines.push(line),
    });
    const handlePromise = provider.startPairing({ timeoutMs: 5_000 });
    await vi.waitFor(() => {
      expect(H.state.lastSocket).toBeTruthy();
    });
    H.state.lastSocket.emit('connect');
    await handlePromise;

    H.state.lastSocket.connected = false;
    H.state.lastSocket.emit('disconnect', 'ping timeout');
    H.state.lastSocket.connect();

    await vi.waitFor(() => {
      expect(lines.some((l) => /signaling socket connected/i.test(l))).toBe(true);
    });
  });
});

describe('LiquidAuthChannelProvider — wake-aware reconnect kick', () => {
  beforeEach(() => {
    (globalThis as any).RTCPeerConnection ??= class {};
    H.socketConnectSpy.mockClear();
    H.state.lastSocket = null;
    H.state.lastClient = null;
    H.state.peerCalls = 0;
    H.state.peerRequestIds = [];
    H.state.peerCloseSpies = [];
    H.state.peerGate = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Start pairing under fake timers (no `connect()` — the wake detector is armed by `startPairing`). */
  async function startPaired(): Promise<void> {
    const provider = new LiquidAuthChannelProvider({ origin: 'https://example.test' });
    let handle: unknown;
    void provider.startPairing({ timeoutMs: 5_000 }).then((h) => {
      handle = h;
    });
    await vi.waitFor(() => {
      expect(H.state.lastSocket).toBeTruthy();
    });
    H.state.lastSocket.emit('connect');
    await vi.waitFor(() => {
      expect(handle).toBeTruthy();
    });
  }

  it('kicks socket.connect() after a wall-clock jump while the socket is down (OS resume)', async () => {
    await startPaired();

    // Ordinary tick: the clock advanced exactly one interval — no jump, no kick.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(H.socketConnectSpy).not.toHaveBeenCalled();

    // The machine suspends: the socket drops, and on resume the wall clock has
    // jumped far past the detector interval while its ticks were frozen.
    H.state.lastSocket.connected = false;
    H.state.lastSocket.emit('disconnect');
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(H.socketConnectSpy).toHaveBeenCalledTimes(1);
    // The fake socket's connect() reconnects immediately.
    expect(H.state.lastSocket.connected).toBe(true);
  });

  it('does NOT kick when the socket stayed connected across a clock jump', async () => {
    await startPaired();

    // A clock jump alone (e.g. NTP correction, or a resume where socket.io
    // already recovered) must not force a reconnect on a healthy socket.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(H.socketConnectSpy).not.toHaveBeenCalled();
  });
});
