import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';

import {
  attachHeartbeatResponder,
  awaitSignalConnect,
  closeAwareTransport,
  closeRtcDataChannel,
  buildSignalingSocketOptions,
  createPairingInvitation,
  getLiquidAuthPairingErrorCode,
  isLiquidAuthPairingCredential,
  monitorTerminalPeerState,
  revokePairing,
  resolveHeartbeatTimeoutMs,
  withSignalingHealthGuard,
} from '../src/providers/liquid-auth.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeSignalingSocket {
  connected = false;
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(listener);
    this.listeners.set(event, handlers);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

describe('Liquid Auth signaling authentication', () => {
  it('reads an explicit nested pairing code even when a generic top-level code is present', () => {
    expect(
      getLiquidAuthPairingErrorCode({
        code: 'SIGNAL_SERVER_ERROR',
        data: { code: 'PAIRING_REVOKED' },
      }),
    ).toBe('PAIRING_REVOKED');
  });

  it('fails immediately with a stable code and removes phase listeners', async () => {
    const socket = new FakeSignalingSocket();
    const onFailure = vi.fn();
    const pending = awaitSignalConnect(socket, { timeoutMs: 1_000, onFailure });
    const handshakeError = Object.assign(new Error('Invalid pairing credentials'), {
      data: { code: 'PAIRING_UNAUTHORIZED' },
    });

    socket.emit('connect_error', handshakeError);

    await expect(pending).rejects.toMatchObject({
      name: 'LiquidAuthPairingError',
      code: 'PAIRING_UNAUTHORIZED',
    });
    expect(socket.listenerCount('connect')).toBe(0);
    expect(socket.listenerCount('connect_error')).toBe(0);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('ignores transient polling errors and resolves on a later reconnect', async () => {
    const socket = new FakeSignalingSocket();
    const onFailure = vi.fn();
    const pending = awaitSignalConnect(socket, { timeoutMs: 1_000, onFailure });

    socket.emit(
      'connect_error',
      Object.assign(new Error('xhr poll error'), {
        context: { status: 0 },
      }),
    );
    expect(socket.listenerCount('connect')).toBe(1);
    expect(socket.listenerCount('connect_error')).toBe(1);

    socket.connected = true;
    socket.emit('connect');

    await expect(pending).resolves.toBeUndefined();
    expect(socket.listenerCount('connect')).toBe(0);
    expect(socket.listenerCount('connect_error')).toBe(0);
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('Liquid Auth durable pairing invitation', () => {
  const pairing = {
    version: 2 as const,
    pairingId: 'pairing-1',
    role: 'provider' as const,
    credential: 'provider-secret',
  };

  it('validates and authenticates the signaling socket with the exact credential', () => {
    expect(isLiquidAuthPairingCredential(pairing)).toBe(true);
    expect(buildSignalingSocketOptions(pairing)).toEqual({
      autoConnect: true,
      withCredentials: true,
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      auth: pairing,
    });
    expect(isLiquidAuthPairingCredential({ ...pairing, role: 'controller' })).toBe(false);
  });

  it('creates an invitation with an optional legacy request id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: 'Created',
      json: async () => pairing,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createPairingInvitation('https://liquid.example/', 'legacy-request-id'),
    ).resolves.toEqual(pairing);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://liquid.example/pairings/invitations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ requestId: 'legacy-request-id' }),
      }),
    );
  });

  it('rejects invalid invitation responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        statusText: 'Created',
        json: async () => ({ pairingId: 'missing-credential' }),
      }),
    );

    await expect(createPairingInvitation('https://liquid.example')).rejects.toThrow(
      'invalid provider credential',
    );
  });

  it('revokes with the provider bearer credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
    });
    vi.stubGlobal('fetch', fetchMock);

    await revokePairing('https://liquid.example/', pairing);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://liquid.example/pairings/pairing-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          authorization: 'Bearer provider-secret',
          'x-pairing-role': 'provider',
        },
      }),
    );
  });

  it.each([404, 410])('treats a %i revocation response as already removed', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: status === 404 ? 'Not Found' : 'Gone',
      }),
    );

    await expect(revokePairing('https://liquid.example/', pairing)).resolves.toBeUndefined();
  });

  it('does not hide an unauthenticated revocation response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    await expect(revokePairing('https://liquid.example/', pairing)).rejects.toThrow(
      '401 Unauthorized',
    );
  });
});

function makeBaseTransport(): Ac2Transport & { emitBaseClose: () => void; closes: () => number } {
  let closeHandler: (() => void) | undefined;
  let closes = 0;
  return {
    send: () => {},
    onMessage: () => {},
    onError: () => {},
    onOpen: () => {},
    onClose: (handler) => {
      closeHandler = handler;
    },
    close: () => {
      closes += 1;
    },
    get isOpen() {
      return true;
    },
    emitBaseClose: () => closeHandler?.(),
    closes: () => closes,
  };
}

describe('awaitSignalConnect', () => {
  function makeFakeSignalClient(): {
    on: (event: string, listener: (...args: any[]) => void) => void;
    emit: (event: string, ...args: any[]) => void;
  } {
    const listeners: Record<string, Array<(...args: any[]) => void>> = {};
    return {
      on(event, listener) {
        (listeners[event] ??= []).push(listener);
      },
      emit(event, ...args) {
        for (const listener of listeners[event] ?? []) listener(...args);
      },
    };
  }

  it('resolves when the signaling socket connects', async () => {
    const client = makeFakeSignalClient();
    let failures = 0;
    const pending = awaitSignalConnect(client, {
      timeoutMs: 1_000,
      onFailure: () => {
        failures += 1;
      },
    });
    client.emit('connect');
    await expect(pending).resolves.toBeUndefined();
    expect(failures).toBe(0);
  });

  it('rejects and tears down the socket when connect never arrives in time', async () => {
    vi.useFakeTimers();
    try {
      const client = makeFakeSignalClient();
      let failures = 0;
      const pending = awaitSignalConnect(client, {
        timeoutMs: 1_000,
        onFailure: () => {
          failures += 1;
        },
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(failures).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately when the abort signal is already aborted', async () => {
    const client = makeFakeSignalClient();
    const controller = new AbortController();
    controller.abort();
    let failures = 0;
    const pending = awaitSignalConnect(client, {
      timeoutMs: 1_000,
      signal: controller.signal,
      onFailure: () => {
        failures += 1;
      },
    });
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(failures).toBe(1);
  });

  it('rejects and tears down when the abort signal fires before connect', async () => {
    const client = makeFakeSignalClient();
    const controller = new AbortController();
    let failures = 0;
    const pending = awaitSignalConnect(client, {
      timeoutMs: 5_000,
      signal: controller.signal,
      onFailure: () => {
        failures += 1;
      },
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(failures).toBe(1);
  });

  it('does not tear down or reject after a successful connect', async () => {
    vi.useFakeTimers();
    try {
      const client = makeFakeSignalClient();
      let failures = 0;
      const pending = awaitSignalConnect(client, {
        timeoutMs: 1_000,
        onFailure: () => {
          failures += 1;
        },
      });
      client.emit('connect');
      await expect(pending).resolves.toBeUndefined();
      // The timer must have been cleared and duplicate connects are no-ops.
      await vi.advanceTimersByTimeAsync(5_000);
      client.emit('connect');
      expect(failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withSignalingHealthGuard', () => {
  function makeFakeSocket(initialConnected = true): {
    on: (event: string, listener: (...args: any[]) => void) => void;
    off: (event: string, listener: (...args: any[]) => void) => void;
    connected: boolean;
    emit: (event: string, ...args: any[]) => void;
    listenerCount: (event: string) => number;
  } {
    const listeners: Record<string, Set<(...args: any[]) => void>> = {};
    return {
      connected: initialConnected,
      on(event, listener) {
        (listeners[event] ??= new Set()).add(listener);
      },
      off(event, listener) {
        listeners[event]?.delete(listener);
      },
      emit(event, ...args) {
        for (const listener of listeners[event] ?? []) listener(...args);
      },
      listenerCount(event) {
        return listeners[event]?.size ?? 0;
      },
    };
  }

  it('resolves with the wrapped promise value when it settles first', async () => {
    const sock = makeFakeSocket();
    let failures = 0;
    const pending = withSignalingHealthGuard(Promise.resolve('peer-channel'), sock, {
      deadSocketTimeoutMs: 1_000,
      onFailure: () => {
        failures += 1;
      },
    });
    await expect(pending).resolves.toBe('peer-channel');
    expect(failures).toBe(0);
  });

  it('passes through a rejection from the wrapped promise unchanged', async () => {
    const sock = makeFakeSocket();
    let failures = 0;
    const boom = new Error('peer negotiation failed');
    const pending = withSignalingHealthGuard(Promise.reject(boom), sock, {
      deadSocketTimeoutMs: 1_000,
      onFailure: () => {
        failures += 1;
      },
    });
    await expect(pending).rejects.toBe(boom);
    expect(failures).toBe(0);
  });

  it('never fires on elapsed time alone while the socket stays connected (slow human)', async () => {
    vi.useFakeTimers();
    try {
      const sock = makeFakeSocket();
      let failures = 0;
      let resolveLate: (value: string) => void = () => {};
      const humanIsSlow = new Promise<string>((resolve) => {
        resolveLate = resolve;
      });
      const pending = withSignalingHealthGuard(humanIsSlow, sock, {
        deadSocketTimeoutMs: 1_000,
        onFailure: () => {
          failures += 1;
        },
      });
      // Far longer than deadSocketTimeoutMs — simulates a human taking minutes
      // to scan the QR and approve, with the socket healthy throughout.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      resolveLate('approved');
      await expect(pending).resolves.toBe('approved');
      expect(failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates a disconnect that recovers before the dead-socket grace period', async () => {
    vi.useFakeTimers();
    try {
      const sock = makeFakeSocket();
      let failures = 0;
      let resolveLate: (value: string) => void = () => {};
      const pending = withSignalingHealthGuard(
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
        sock,
        {
          deadSocketTimeoutMs: 1_000,
          onFailure: () => {
            failures += 1;
          },
        },
      );
      sock.emit('disconnect');
      await vi.advanceTimersByTimeAsync(500);
      sock.emit('connect'); // recovers before the 1_000ms grace period elapses
      await vi.advanceTimersByTimeAsync(5_000);
      resolveLate('approved');
      await expect(pending).resolves.toBe('approved');
      expect(failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts short disconnects against one cumulative offline budget', async () => {
    vi.useFakeTimers();
    try {
      const sock = makeFakeSocket();
      const pending = withSignalingHealthGuard(new Promise<never>(() => {}), sock, {
        deadSocketTimeoutMs: 1_000,
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });

      for (let index = 0; index < 3; index += 1) {
        sock.emit('disconnect');
        await vi.advanceTimersByTimeAsync(300);
        sock.emit('connect');
      }
      sock.emit('disconnect');
      await vi.advanceTimersByTimeAsync(99);
      expect(sock.listenerCount('disconnect')).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let duplicate disconnect events reset the remaining budget', async () => {
    vi.useFakeTimers();
    try {
      const sock = makeFakeSocket();
      const pending = withSignalingHealthGuard(new Promise<never>(() => {}), sock, {
        deadSocketTimeoutMs: 1_000,
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });

      sock.emit('disconnect');
      await vi.advanceTimersByTimeAsync(600);
      sock.emit('disconnect');
      await vi.advanceTimersByTimeAsync(399);
      expect(sock.listenerCount('disconnect')).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('recycles a stale handshake after a wall-clock suspension', async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const sock = makeFakeSocket();
      const pending = withSignalingHealthGuard(new Promise<never>(() => {}), sock, {
        deadSocketTimeoutMs: 1_000,
        now: () => clock,
        pollIntervalMs: 10,
        suspendGapMs: 60,
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });

      clock = 60;
      await vi.advanceTimersByTimeAsync(10);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a healthy slow-human handshake alive across ordinary health polls', async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      let resolveHandshake: (value: string) => void = () => {};
      const sock = makeFakeSocket();
      const pending = withSignalingHealthGuard(
        new Promise<string>((resolve) => {
          resolveHandshake = resolve;
        }),
        sock,
        {
          deadSocketTimeoutMs: 1_000,
          now: () => clock,
          pollIntervalMs: 10,
          suspendGapMs: 60,
        },
      );

      for (let index = 0; index < 20; index += 1) {
        clock += 10;
        await vi.advanceTimersByTimeAsync(10);
      }
      resolveHandshake('approved');

      await expect(pending).resolves.toBe('approved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up health timers and socket listeners after settlement', async () => {
    vi.useFakeTimers();
    try {
      const sock = makeFakeSocket();
      const pending = withSignalingHealthGuard(Promise.resolve('approved'), sock, {
        deadSocketTimeoutMs: 1_000,
      });

      await expect(pending).resolves.toBe('approved');
      expect(vi.getTimerCount()).toBe(0);
      expect(sock.listenerCount('disconnect')).toBe(0);
      expect(sock.listenerCount('connect')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects and tears down once the socket stays disconnected past the grace period', async () => {
    vi.useFakeTimers();
    try {
      const sock = makeFakeSocket();
      let failures = 0;
      const pending = withSignalingHealthGuard(new Promise<never>(() => {}), sock, {
        deadSocketTimeoutMs: 1_000,
        onFailure: () => {
          failures += 1;
        },
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      sock.emit('disconnect');
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(failures).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts counting immediately if the socket is already disconnected', async () => {
    vi.useFakeTimers();
    try {
      const sock = makeFakeSocket(false);
      let failures = 0;
      const pending = withSignalingHealthGuard(new Promise<never>(() => {}), sock, {
        deadSocketTimeoutMs: 1_000,
        onFailure: () => {
          failures += 1;
        },
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(failures).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately on a server-initiated disconnect (no auto-reconnect)', async () => {
    vi.useFakeTimers();
    try {
      const sock = makeFakeSocket();
      let failures = 0;
      const pending = withSignalingHealthGuard(new Promise<never>(() => {}), sock, {
        deadSocketTimeoutMs: 45_000,
        onFailure: () => {
          failures += 1;
        },
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      // 'io server disconnect' will never auto-reconnect — must fail now,
      // without waiting out the dead-socket grace period.
      sock.emit('disconnect', 'io server disconnect');
      await assertion;
      expect(failures).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately when the abort signal is already aborted', async () => {
    const sock = makeFakeSocket();
    const controller = new AbortController();
    controller.abort();
    let failures = 0;
    const pending = withSignalingHealthGuard(new Promise<never>(() => {}), sock, {
      deadSocketTimeoutMs: 5_000,
      signal: controller.signal,
      onFailure: () => {
        failures += 1;
      },
    });
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(failures).toBe(1);
  });

  it('rejects and tears down when the abort signal fires mid-handshake', async () => {
    const sock = makeFakeSocket();
    const controller = new AbortController();
    let failures = 0;
    const pending = withSignalingHealthGuard(new Promise<never>(() => {}), sock, {
      deadSocketTimeoutMs: 5_000,
      signal: controller.signal,
      onFailure: () => {
        failures += 1;
      },
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(failures).toBe(1);
  });

  it('ignores a late settle once the dead-socket bound has already tripped', async () => {
    vi.useFakeTimers();
    try {
      const sock = makeFakeSocket();
      let failures = 0;
      let resolveLate: (value: string) => void = () => {};
      const late = new Promise<string>((resolve) => {
        resolveLate = resolve;
      });
      const pending = withSignalingHealthGuard(late, sock, {
        deadSocketTimeoutMs: 1_000,
        onFailure: () => {
          failures += 1;
        },
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      sock.emit('disconnect');
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      resolveLate('too-late');
      expect(failures).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('monitorTerminalPeerState', () => {
  class FakePeer {
    iceConnectionState = 'connected';
    connectionState = 'connected';
    private readonly listeners = new Map<string, Set<() => void>>();

    addEventListener(event: string, listener: () => void): void {
      const handlers = this.listeners.get(event) ?? new Set();
      handlers.add(listener);
      this.listeners.set(event, handlers);
    }

    removeEventListener(event: string, listener: () => void): void {
      this.listeners.get(event)?.delete(listener);
    }

    emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.size ?? 0;
    }
  }

  it('reports terminal ICE or connection states only once', () => {
    const peer = new FakePeer();
    const onTerminal = vi.fn();
    monitorTerminalPeerState(peer, onTerminal);

    peer.iceConnectionState = 'failed';
    peer.emit('iceconnectionstatechange');
    peer.connectionState = 'closed';
    peer.emit('connectionstatechange');

    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith('iceConnectionState:failed');
  });

  it('detects a peer that is already terminal during attachment', () => {
    const peer = new FakePeer();
    peer.connectionState = 'failed';
    const onTerminal = vi.fn();

    monitorTerminalPeerState(peer, onTerminal);

    expect(onTerminal).toHaveBeenCalledWith('connectionState:failed');
  });

  it('does not close for transient disconnects or later recovery', () => {
    const peer = new FakePeer();
    const onTerminal = vi.fn();
    monitorTerminalPeerState(peer, onTerminal);

    peer.iceConnectionState = 'disconnected';
    peer.connectionState = 'disconnected';
    peer.emit('iceconnectionstatechange');
    peer.emit('connectionstatechange');
    peer.iceConnectionState = 'connected';
    peer.connectionState = 'connected';
    peer.emit('iceconnectionstatechange');

    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('removes only its own listeners and ignores events after disposal', () => {
    const peer = new FakePeer();
    const existing = vi.fn();
    peer.addEventListener('iceconnectionstatechange', existing);
    const onTerminal = vi.fn();
    const dispose = monitorTerminalPeerState(peer, onTerminal);

    expect(peer.listenerCount('iceconnectionstatechange')).toBe(2);
    dispose();
    dispose();
    expect(peer.listenerCount('iceconnectionstatechange')).toBe(1);
    peer.iceConnectionState = 'failed';
    peer.emit('iceconnectionstatechange');

    expect(existing).toHaveBeenCalledOnce();
    expect(onTerminal).not.toHaveBeenCalled();
  });
});

describe('LiquidAuthChannelProvider heartbeat timeout', () => {
  it('is disabled by default so mobile background suspension is not treated as death', () => {
    expect(resolveHeartbeatTimeoutMs()).toBeUndefined();
    expect(resolveHeartbeatTimeoutMs('')).toBeUndefined();
  });

  it('accepts timeout overrides at or above two heartbeat intervals', () => {
    expect(resolveHeartbeatTimeoutMs('40000')).toBe(40_000);
    expect(resolveHeartbeatTimeoutMs(40_000)).toBe(40_000);
    expect(resolveHeartbeatTimeoutMs('900000')).toBe(900_000);
  });

  it('disables invalid or too-small overrides', () => {
    expect(resolveHeartbeatTimeoutMs('not-a-number')).toBeUndefined();
    expect(resolveHeartbeatTimeoutMs('39999')).toBeUndefined();
    expect(resolveHeartbeatTimeoutMs(39_999)).toBeUndefined();
  });

  it('wires ping responses immediately when a heartbeat channel is discovered', () => {
    const onInbound = vi.fn();
    const channel = {
      readyState: 'open',
      onmessage: null as ((event: { data: unknown }) => void) | null,
      send: vi.fn(),
    };

    attachHeartbeatResponder(channel, onInbound);
    channel.onmessage?.({ data: 'ping' });

    expect(onInbound).toHaveBeenCalledOnce();
    expect(channel.send).toHaveBeenCalledWith('pong');
  });

  it('records other heartbeat traffic without echoing it', () => {
    const onInbound = vi.fn();
    const channel = {
      readyState: 'open',
      onmessage: null as ((event: { data: unknown }) => void) | null,
      send: vi.fn(),
    };

    attachHeartbeatResponder(channel, onInbound);
    channel.onmessage?.({ data: 'pong' });

    expect(onInbound).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
  });
});

describe('closeRtcDataChannel', () => {
  it('closes non-closed DataChannels', () => {
    let closed = false;
    closeRtcDataChannel({
      readyState: 'open',
      close: () => {
        closed = true;
      },
    });
    expect(closed).toBe(true);
  });

  it('ignores absent, already closed, or throwing channels', () => {
    expect(() => closeRtcDataChannel(undefined)).not.toThrow();
    expect(() =>
      closeRtcDataChannel({
        readyState: 'closed',
        close: () => {
          throw new Error('should not be called');
        },
      }),
    ).not.toThrow();
    expect(() =>
      closeRtcDataChannel({
        readyState: 'closing',
        close: () => {
          throw new Error('already closing');
        },
      }),
    ).not.toThrow();
  });
});

describe('closeAwareTransport', () => {
  it('notifies every close listener when the base transport closes', () => {
    const base = makeBaseTransport();
    const { transport } = closeAwareTransport(base);
    const seen: string[] = [];

    transport.onClose(() => seen.push('client'));
    transport.onClose(() => seen.push('session-loop'));
    base.emitBaseClose();

    expect(seen).toEqual(['client', 'session-loop']);
  });

  it('emits close when the provider closes the transport even if the base does not', () => {
    const base = makeBaseTransport();
    const { transport, emitClose } = closeAwareTransport(base);
    const seen: string[] = [];

    transport.onClose(() => seen.push('session-loop'));
    emitClose();
    emitClose();

    expect(seen).toEqual(['session-loop']);
  });

  it('emits close from transport.close for native transports that do not emit onclose', () => {
    const base = makeBaseTransport();
    const { transport } = closeAwareTransport(base);
    let closed = 0;

    transport.onClose(() => {
      closed += 1;
    });
    transport.close();

    expect(base.closes()).toBe(1);
    expect(closed).toBe(1);
  });

  it('immediately calls listeners registered after close emission', () => {
    const base = makeBaseTransport();
    const { transport, emitClose } = closeAwareTransport(base);
    let closed = 0;

    emitClose();
    transport.onClose(() => {
      closed += 1;
    });

    expect(closed).toBe(1);
  });

  it('allows close listeners to unsubscribe idempotently', () => {
    const base = makeBaseTransport();
    const { transport, emitClose } = closeAwareTransport(base);
    const handler = vi.fn();

    const unsubscribe = transport.onClose(handler);
    expect(unsubscribe).toBeTypeOf('function');
    unsubscribe?.();
    unsubscribe?.();
    emitClose();

    expect(handler).not.toHaveBeenCalled();
  });
});
