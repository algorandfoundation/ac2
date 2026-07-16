import { describe, expect, it, vi } from 'vitest';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';

import {
  awaitSignalConnect,
  closeAwareTransport,
  closeRtcDataChannel,
  resolveHeartbeatTimeoutMs,
} from '../src/providers/liquid-auth.js';

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
