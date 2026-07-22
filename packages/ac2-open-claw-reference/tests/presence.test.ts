import { describe, expect, it, vi } from 'vitest';

import {
  AC2_PRESENCE_EVENT,
  hasPeerPresence,
  normalizePresence,
  queryPresence,
  shouldTeardownOnPresence,
  subscribeToPresence,
} from '../src/providers/liquid-auth.js';

type Ack = (data: unknown) => void;

/** Minimal socket.io-like mock capturing the presence emit + broadcasts. */
function createFakeSocket() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  let lastEmit: { event: string; payload: unknown; ack?: Ack | undefined } | undefined;
  return {
    lastEmit: () => lastEmit,
    emit(event: string, payload: unknown, ack?: Ack) {
      lastEmit = { event, payload, ack };
    },
    on(event: string, listener: (...args: any[]) => void) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener);
    },
    off(event: string, listener: (...args: any[]) => void) {
      listeners.get(event)?.delete(listener);
    },
    broadcast(event: string, ...args: any[]) {
      listeners.get(event)?.forEach((l) => l(...args));
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

describe('normalizePresence', () => {
  it('passes through a well-formed payload', () => {
    expect(
      normalizePresence('req-1', { requestId: 'req-1', deviceCount: 2, online: true }),
    ).toEqual({ requestId: 'req-1', deviceCount: 2, online: true });
  });

  it('derives online from deviceCount and falls back to the queried id', () => {
    expect(normalizePresence('req-2', { deviceCount: 3 })).toEqual({
      requestId: 'req-2',
      deviceCount: 3,
      online: true,
    });
    expect(normalizePresence('req-3', {})).toEqual({
      requestId: 'req-3',
      deviceCount: 0,
      online: false,
    });
  });

  it('tolerates a null/undefined payload', () => {
    expect(normalizePresence('req-4', null)).toEqual({
      requestId: 'req-4',
      deviceCount: 0,
      online: false,
    });
  });
});

describe('queryPresence', () => {
  it('emits the presence event and resolves with the server ack', async () => {
    const socket = createFakeSocket();
    const pending = queryPresence(socket, 'req-1');
    const emit = socket.lastEmit();
    expect(emit?.event).toBe(AC2_PRESENCE_EVENT);
    expect(emit?.payload).toEqual({ requestId: 'req-1' });
    emit?.ack?.({ requestId: 'req-1', deviceCount: 2, online: true });
    await expect(pending).resolves.toEqual({ requestId: 'req-1', deviceCount: 2, online: true });
  });

  it('rejects on an empty requestId without emitting', async () => {
    const socket = createFakeSocket();
    await expect(queryPresence(socket, '')).rejects.toThrow(/non-empty requestId/);
    expect(socket.lastEmit()).toBeUndefined();
  });

  it('rejects when no ack arrives within the timeout', async () => {
    vi.useFakeTimers();
    try {
      const socket = createFakeSocket();
      const pending = queryPresence(socket, 'req-1', { timeoutMs: 5_000 });
      const assertion = expect(pending).rejects.toThrow(/timed out waiting for presence ack/);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects if the socket emit throws', async () => {
    const socket = {
      emit: () => {
        throw new Error('socket down');
      },
    };
    await expect(queryPresence(socket as any, 'req-1')).rejects.toThrow('socket down');
  });
});

describe('subscribeToPresence', () => {
  it('forwards normalized broadcasts and unsubscribes cleanly', () => {
    const socket = createFakeSocket();
    const seen: unknown[] = [];
    const unsubscribe = subscribeToPresence(socket, (p) => seen.push(p));

    socket.broadcast(AC2_PRESENCE_EVENT, { requestId: 'req-1', deviceCount: 1, online: true });
    socket.broadcast(AC2_PRESENCE_EVENT, { requestId: 'req-1', deviceCount: 0 });

    expect(seen).toEqual([
      { requestId: 'req-1', deviceCount: 1, online: true },
      { requestId: 'req-1', deviceCount: 0, online: false },
    ]);

    unsubscribe();
    expect(socket.listenerCount(AC2_PRESENCE_EVENT)).toBe(0);
  });

  it('is a no-op against a socket without on/off', () => {
    const unsubscribe = subscribeToPresence({ emit: () => {} }, () => {});
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('shouldTeardownOnPresence', () => {
  it('tears down once a linked wallet drops back to a single device (while connecting)', () => {
    expect(
      shouldTeardownOnPresence(
        { requestId: 'req-1', deviceCount: 1, online: true },
        { peerLinked: true, closed: false, connected: false, signalingStable: true },
      ),
    ).toBe(true);
    // Zero devices (both gone) also counts as the peer being offline.
    expect(
      shouldTeardownOnPresence(
        { requestId: 'req-1', deviceCount: 0, online: false },
        { peerLinked: true, closed: false, connected: false, signalingStable: true },
      ),
    ).toBe(true);
  });

  it('does not tear down while the wallet is still present (2+ devices)', () => {
    expect(
      shouldTeardownOnPresence(
        { requestId: 'req-1', deviceCount: 2, online: true },
        { peerLinked: true, closed: false, connected: true, signalingStable: true },
      ),
    ).toBe(false);
  });

  it('does not tear down before the first link (single device is normal)', () => {
    expect(
      shouldTeardownOnPresence(
        { requestId: 'req-1', deviceCount: 1, online: true },
        { peerLinked: false, closed: false, connected: false, signalingStable: true },
      ),
    ).toBe(false);
  });

  it('never re-triggers once already closed', () => {
    expect(
      shouldTeardownOnPresence(
        { requestId: 'req-1', deviceCount: 0, online: false },
        { peerLinked: true, closed: true, connected: true, signalingStable: true },
      ),
    ).toBe(false);
  });

  it('tears down a LIVE connection when the peer goes offline and signaling is stable', () => {
    // The phone closed: the server broadcasts a drop to a single device while
    // our own signaling link is healthy. This is a real departure — close now
    // (and re-arm) rather than waiting out the heartbeat.
    expect(
      shouldTeardownOnPresence(
        { requestId: 'req-1', deviceCount: 1, online: true },
        { peerLinked: true, closed: false, connected: true, signalingStable: true },
      ),
    ).toBe(true);
    expect(
      shouldTeardownOnPresence(
        { requestId: 'req-1', deviceCount: 0, online: false },
        { peerLinked: true, closed: false, connected: true, signalingStable: true },
      ),
    ).toBe(true);
  });

  it('does NOT tear down a live connection on a presence drop caused by a signaling-server loss', () => {
    // Our own signaling socket dropped/reconnected (`signalingStable === false`)
    // so a transient low device count is a recount artifact, not a departure.
    // The live data channel already proves the peer is there; leave it alone.
    expect(
      shouldTeardownOnPresence(
        { requestId: 'req-1', deviceCount: 1, online: true },
        { peerLinked: true, closed: false, connected: true, signalingStable: false },
      ),
    ).toBe(false);
    expect(
      shouldTeardownOnPresence(
        { requestId: 'req-1', deviceCount: 0, online: false },
        { peerLinked: true, closed: false, connected: true, signalingStable: false },
      ),
    ).toBe(false);
  });

  it('still tears down while connecting even if signaling is unstable (no live channel to trust)', () => {
    // Before the control channel is live there is no p2p connection to protect,
    // so a linked peer dropping to a single device is always acted on.
    expect(
      shouldTeardownOnPresence(
        { requestId: 'req-1', deviceCount: 1, online: true },
        { peerLinked: true, closed: false, connected: false, signalingStable: false },
      ),
    ).toBe(true);
  });
});

describe('hasPeerPresence', () => {
  it('resolves true when at least one device is connected', async () => {
    const socket = createFakeSocket();
    const pending = hasPeerPresence(socket, 'req-1');
    socket.lastEmit()?.ack?.({ requestId: 'req-1', deviceCount: 1, online: true });
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when nobody is connected', async () => {
    const socket = createFakeSocket();
    const pending = hasPeerPresence(socket, 'req-1');
    socket.lastEmit()?.ack?.({ requestId: 'req-1', deviceCount: 0, online: false });
    await expect(pending).resolves.toBe(false);
  });

  it('swallows query errors into false', async () => {
    await expect(hasPeerPresence({ emit: () => {} }, '')).resolves.toBe(false);
  });
});
