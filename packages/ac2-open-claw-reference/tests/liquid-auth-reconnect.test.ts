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
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const clientCloseSpy = vi.fn<(disconnect?: boolean) => void>();
  const socketCloseSpy = vi.fn<() => void>();
  const socketDisconnectSpy = vi.fn<() => void>();
  const state = {
    lastSocket: null as any,
    lastClient: null as any,
    peerCalls: 0,
    peerCloseSpies: [] as Array<ReturnType<typeof vi.fn>>,
  };
  return { clientCloseSpy, socketCloseSpy, socketDisconnectSpy, state };
});

vi.mock('socket.io-client', () => ({
  io: (_url: string, _opts: unknown) => {
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
      _requestId: string,
      _type: string,
      _config: unknown,
      opts: { dataChannels: Record<string, unknown> },
    ): Promise<any> {
      H.state.peerCalls += 1;
      const peerCloseSpy = vi.fn();
      this.peerClient = { close: peerCloseSpy };
      H.state.peerCloseSpies.push(peerCloseSpy);
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
    H.state.lastSocket = null;
    H.state.lastClient = null;
    H.state.peerCalls = 0;
    H.state.peerCloseSpies = [];
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
