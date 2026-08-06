/**
 * Unit tests for `withNegotiationStallGuard` — the post-offer handshake
 * deadline that keeps a re-armed `connect()` from wedging forever after it
 * answers a stale offer (e.g. one flushed from the wallet's cancelled attempt
 * when its socket reconnected after a network switch). The guard must:
 *
 *  - impose NO deadline before an offer is received (that phase waits on the
 *    human scanning the QR / reopening the wallet and can take arbitrarily
 *    long);
 *  - once `offer-description` fires, reject with `NegotiationStallError` (and
 *    run `onFailure`) if the handshake promise has not settled within the
 *    stall window;
 *  - arm exactly once — offer re-emissions must not push the deadline out;
 *  - pass through resolution/rejection untouched and detach its listener.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NegotiationStallError,
  withNegotiationStallGuard,
} from '../src/providers/liquid-auth.js';

type Listener = (...args: any[]) => void;

function makeEmitter() {
  const listeners: Record<string, Listener[]> = {};
  return {
    on(event: string, listener: Listener) {
      (listeners[event] ??= []).push(listener);
    },
    off(event: string, listener: Listener) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
    },
    emit(event: string, ...args: any[]) {
      for (const listener of [...(listeners[event] ?? [])]) listener(...args);
    },
    count(event: string): number {
      return (listeners[event] ?? []).length;
    },
  };
}

describe('withNegotiationStallGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('imposes no deadline before an offer is received', async () => {
    const client = makeEmitter();
    const onFailure = vi.fn();
    let resolvePeer!: (value: string) => void;
    const peer = new Promise<string>((resolve) => {
      resolvePeer = resolve;
    });

    const guarded = withNegotiationStallGuard(peer, client, {
      stallTimeoutMs: 30_000,
      onFailure,
    });

    // Hours pass while the wallet is closed — nothing may reject.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(onFailure).not.toHaveBeenCalled();

    resolvePeer('channel');
    await expect(guarded).resolves.toBe('channel');
  });

  it('rejects with NegotiationStallError when no channel opens after an offer', async () => {
    const client = makeEmitter();
    const onFailure = vi.fn();
    const peer = new Promise<string>(() => {
      /* never settles — the answered offer is dead */
    });

    const guarded = withNegotiationStallGuard(peer, client, {
      stallTimeoutMs: 30_000,
      onFailure,
    });
    const outcome = expect(guarded).rejects.toBeInstanceOf(NegotiationStallError);

    client.emit('offer-description', { type: 'offer', sdp: 'v=0' });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(onFailure).toHaveBeenCalledTimes(1);
    // The guard's listener is detached once settled.
    expect(client.count('offer-description')).toBe(0);
  });

  it('arms once: offer re-emissions do not extend the deadline', async () => {
    const client = makeEmitter();
    const onFailure = vi.fn();
    const peer = new Promise<string>(() => {
      /* never settles */
    });

    const guarded = withNegotiationStallGuard(peer, client, {
      stallTimeoutMs: 30_000,
      onFailure,
    });
    const outcome = expect(guarded).rejects.toBeInstanceOf(NegotiationStallError);

    client.emit('offer-description', { type: 'offer', sdp: 'v=0' });
    await vi.advanceTimersByTimeAsync(20_000);
    // A resent offer 20s in must not reset the clock to a fresh 30s.
    client.emit('offer-description', { type: 'offer', sdp: 'v=0' });
    await vi.advanceTimersByTimeAsync(10_000);

    await outcome;
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('resolves normally when the channel opens within the stall window', async () => {
    const client = makeEmitter();
    const onFailure = vi.fn();
    let resolvePeer!: (value: string) => void;
    const peer = new Promise<string>((resolve) => {
      resolvePeer = resolve;
    });

    const guarded = withNegotiationStallGuard(peer, client, {
      stallTimeoutMs: 30_000,
      onFailure,
    });

    client.emit('offer-description', { type: 'offer', sdp: 'v=0' });
    await vi.advanceTimersByTimeAsync(5_000);
    resolvePeer('channel');
    await expect(guarded).resolves.toBe('channel');

    // The stall timer is cancelled and the listener detached.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFailure).not.toHaveBeenCalled();
    expect(client.count('offer-description')).toBe(0);
  });

  it('passes through an underlying rejection untouched', async () => {
    const client = makeEmitter();
    const onFailure = vi.fn();
    const boom = new Error('peer exploded');
    const guarded = withNegotiationStallGuard(Promise.reject(boom), client, {
      stallTimeoutMs: 30_000,
      onFailure,
    });

    await expect(guarded).rejects.toBe(boom);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
