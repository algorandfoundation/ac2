import { describe, expect, it } from 'vitest';

import { closeRtcDataChannel, resolveHeartbeatTimeoutMs } from '../src/providers/liquid-auth.js';

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
