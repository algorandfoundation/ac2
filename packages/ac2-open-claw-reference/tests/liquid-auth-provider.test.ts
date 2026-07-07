import { describe, expect, it } from 'vitest';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';

import {
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
