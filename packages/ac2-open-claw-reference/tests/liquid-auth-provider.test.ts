import { describe, expect, it, vi } from 'vitest';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';

import {
  awaitSignalConnect,
  closeAwareTransport,
  closeRtcDataChannel,
  resolveHeartbeatTimeoutMs,
  withSignalingHealthGuard,
} from '../src/providers/liquid-auth.js';

function makeBaseTransport(): Ac2Transport & { emitBaseClose: () => void; closes: () => number } {
  let closeHandler: (() => void) | undefined;
  let closes = 0;
  return {
    send: () => { },
    onMessage: () => { },
    onError: () => { },
    onOpen: () => { },
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
    emit: (event: string) => void;
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
      emit(event) {
        for (const listener of listeners[event] ?? []) listener();
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
      let resolveLate: (value: string) => void = () => { };
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
      let resolveLate: (value: string) => void = () => { };
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

  it('rejects and tears down once the socket stays disconnected past the grace period', async () => {
    vi.useFakeTimers();
    try {
      const sock = makeFakeSocket();
      let failures = 0;
      const pending = withSignalingHealthGuard(new Promise<never>(() => { }), sock, {
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
      const pending = withSignalingHealthGuard(new Promise<never>(() => { }), sock, {
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

  it('rejects immediately when the abort signal is already aborted', async () => {
    const sock = makeFakeSocket();
    const controller = new AbortController();
    controller.abort();
    let failures = 0;
    const pending = withSignalingHealthGuard(new Promise<never>(() => { }), sock, {
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
    const pending = withSignalingHealthGuard(new Promise<never>(() => { }), sock, {
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
      let resolveLate: (value: string) => void = () => { };
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

describe('LiquidAuthChannelProvider heartbeat timeout', () => {
  it('defaults to the standard heartbeat timeout', () => {
    expect(resolveHeartbeatTimeoutMs()).toBe(50_000);
    expect(resolveHeartbeatTimeoutMs('')).toBe(50_000);
  });

  it('accepts timeout overrides at or above two heartbeat intervals', () => {
    expect(resolveHeartbeatTimeoutMs('40000')).toBe(40_000);
    expect(resolveHeartbeatTimeoutMs('900000')).toBe(900_000);
  });

  it('falls back for invalid or too-small overrides', () => {
    expect(resolveHeartbeatTimeoutMs('not-a-number')).toBe(50_000);
    expect(resolveHeartbeatTimeoutMs('39999')).toBe(50_000);
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
});
