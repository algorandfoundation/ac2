/**
 * Tests for `createWebSocketConnection` (`src/runtime/gateway/connection.ts`)
 * — specifically the close/error funneling around the global `WebSocket`.
 *
 * Node's undici `WebSocket` fires ONLY an `error` event (no `close`) when a
 * connection fails to establish, e.g. nothing listens on the target port
 * (verified against Node 22). The wrapper must surface that through `onClose`
 * anyway — the `openclaw-gateway` adapter schedules its reconnects from
 * `onClose` alone, and missing the event left the daemon permanently stuck on
 * a dead client whenever it started while the gateway was down.
 *
 * Runs against a stubbed `globalThis.WebSocket`, so no real socket is opened
 * anywhere in the suite.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createWebSocketConnection } from '../src/runtime/gateway/connection.js';

type Listener = (event: unknown) => void;

/** A recording stand-in for the global `WebSocket`, driven by the tests. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Listener[]>();
  sent: string[] = [];
  closed = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed += 1;
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const globalWithWebSocket = globalThis as { WebSocket?: unknown };
const realWebSocket = globalWithWebSocket.WebSocket;

afterEach(() => {
  FakeWebSocket.instances = [];
  if (realWebSocket === undefined) delete globalWithWebSocket.WebSocket;
  else globalWithWebSocket.WebSocket = realWebSocket;
});

function connectFake(): {
  connection: ReturnType<typeof createWebSocketConnection>;
  socket: FakeWebSocket;
  reasons: string[];
} {
  globalWithWebSocket.WebSocket = FakeWebSocket;
  const connection = createWebSocketConnection('ws://127.0.0.1:18789');
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  const reasons: string[] = [];
  connection.onClose((reason) => reasons.push(reason));
  return { connection, socket, reasons };
}

describe('createWebSocketConnection', () => {
  it('throws when no global WebSocket is available', () => {
    delete globalWithWebSocket.WebSocket;
    expect(() => createWebSocketConnection('ws://127.0.0.1:18789')).toThrow(
      /no global WebSocket is available/,
    );
  });

  it('reports a plain close through onClose with the code when no reason is given', () => {
    const { socket, reasons } = connectFake();
    socket.emit('close', { code: 1006, reason: '' });
    expect(reasons).toEqual(['closed (code 1006)']);
  });

  it('reports an error-only failure through onClose (undici fires no close event)', () => {
    const { socket, reasons } = connectFake();
    socket.emit('error', { message: 'Received network error or non-101 status code.' });
    expect(reasons).toEqual(['Received network error or non-101 status code.']);
  });

  it('falls back to a generic reason when the error event carries no message', () => {
    const { socket, reasons } = connectFake();
    socket.emit('error', {});
    expect(reasons).toEqual(['websocket error']);
  });

  it('fires onClose exactly once when error and close both arrive', () => {
    const { socket, reasons } = connectFake();
    socket.emit('error', { message: 'connection reset' });
    socket.emit('close', { code: 1006, reason: '' });
    expect(reasons).toEqual(['connection reset']);
  });

  it('notifies every registered onClose callback', () => {
    const { connection, socket, reasons } = connectFake();
    const more: string[] = [];
    connection.onClose((reason) => more.push(reason));
    socket.emit('close', { code: 1000, reason: 'bye' });
    expect(reasons).toEqual(['bye']);
    expect(more).toEqual(['bye']);
  });
});
