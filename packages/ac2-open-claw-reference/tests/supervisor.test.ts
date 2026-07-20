import { describe, expect, it } from 'vitest';

import {
  Ac2ConnectionSupervisor,
  buildChannelObject,
  isPairingAuthorizationError,
  reconnectDelayMs,
} from '../src/index.js';

describe('AC2 gateway supervisor', () => {
  it('uses bounded exponential backoff with jitter', () => {
    expect(reconnectDelayMs(1, () => 0)).toBe(800);
    expect(reconnectDelayMs(2, () => 0.5)).toBe(2_000);
    expect(reconnectDelayMs(100, () => 1)).toBe(30_000);
  });

  it('rotates only explicit unauthorized invitations, never revoked pairings', () => {
    expect(isPairingAuthorizationError({ data: { code: 'PAIRING_UNAUTHORIZED' } })).toBe(true);
    expect(isPairingAuthorizationError({ code: 'PAIRING_REVOKED' })).toBe(false);
    expect(isPairingAuthorizationError({ code: 'SIGNAL_SERVER_ERROR' })).toBe(false);
    expect(
      isPairingAuthorizationError({
        status: 'error',
        message: 'Internal server error',
        cause: { pattern: 'link' },
      }),
    ).toBe(false);
    expect(isPairingAuthorizationError(new Error('xhr poll error'))).toBe(false);
  });

  it('stops without starting network work when the gateway is already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const supervisor = new Ac2ConnectionSupervisor();

    await supervisor.start({
      api: {} as never,
      config: {},
      signal: abort.signal,
    });

    expect(supervisor.getStatus()).toEqual({ state: 'stopped', reconnectAttempts: 0 });
  });

  it('exposes a stable gateway account while no controller is online', () => {
    const channel = buildChannelObject() as any;

    expect(channel.config.listAccountIds({})).toEqual(['default']);
    expect(channel.config.resolveAccount({}, undefined).accountId).toBe('default');
    expect(typeof channel.gateway.startAccount).toBe('function');
    expect(typeof channel.gateway.stopAccount).toBe('function');
  });
});
