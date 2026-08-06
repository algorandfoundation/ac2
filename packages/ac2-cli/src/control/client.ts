/**
 * Typed NDJSON client for the AC2 daemon control socket.
 *
 * Connects to the Unix domain socket (named pipe on Windows), correlates
 * request/response pairs by auto-incrementing id, and dispatches `{ event,
 * data }` notifications to registered listeners. See
 * {@link ./protocol.ts} for the wire format.
 */

import { connect, type Socket } from 'node:net';
import {
  resolveControlSocketPath,
  type ControlErrorCode,
  type ControlEventName,
  type ControlEvents,
  type ControlMethodName,
  type ControlMethods,
} from './protocol.js';

export interface ControlClientOptions {
  /** Socket path; defaults to {@link resolveControlSocketPath}. */
  path?: string;
  /** Connection timeout in milliseconds (default 5000). */
  timeoutMs?: number;
}

/** Listener for a single control event. */
export type ControlEventHandler<E extends ControlEventName> = (data: ControlEvents[E]) => void;

export interface ControlClient {
  /** Send a request and await its typed result. */
  request<M extends ControlMethodName>(
    method: M,
    params: ControlMethods[M]['params'],
  ): Promise<ControlMethods[M]['result']>;
  /** Register an event listener. */
  on<E extends ControlEventName>(event: E, handler: ControlEventHandler<E>): void;
  /** Remove a previously registered event listener. */
  off<E extends ControlEventName>(event: E, handler: ControlEventHandler<E>): void;
  /** Convenience wrapper around the `subscribe` method. */
  subscribe(events?: ControlEventName[]): Promise<ControlEventName[]>;
  /** Destroy the socket; pending requests reject. */
  close(): void;
  /** Resolves once the socket has fully closed. */
  closed: Promise<void>;
}

/** Error raised for daemon-side failures; carries the protocol error code. */
export class ControlRequestError extends Error {
  constructor(
    message: string,
    readonly code: ControlErrorCode,
  ) {
    super(message);
    this.name = 'ControlRequestError';
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Connect to the daemon control socket. */
export function connectControl(options: ControlClientOptions = {}): Promise<ControlClient> {
  const path = options.path ?? resolveControlSocketPath();
  const timeoutMs = options.timeoutMs ?? 5000;

  return new Promise((resolveConnect, rejectConnect) => {
    const socket: Socket = connect(path);
    const pending = new Map<number, PendingRequest>();
    const listeners = new Map<ControlEventName, Set<(data: never) => void>>();
    let nextId = 1;
    let buffer = '';
    let connected = false;

    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const connectTimer = setTimeout(() => {
      if (!connected) {
        socket.destroy();
        rejectConnect(new Error(`control socket connect timed out: ${path}`));
      }
    }, timeoutMs);

    function failPending(reason: Error): void {
      for (const { reject } of pending.values()) reject(reason);
      pending.clear();
    }

    function handleFrame(frame: unknown): void {
      if (typeof frame !== 'object' || frame === null) return;
      const record = frame as {
        id?: unknown;
        result?: unknown;
        error?: { code?: unknown; message?: unknown };
        event?: unknown;
        data?: unknown;
      };
      if (typeof record.event === 'string') {
        const handlers = listeners.get(record.event as ControlEventName);
        if (handlers) {
          for (const handler of [...handlers]) {
            (handler as (data: unknown) => void)(record.data);
          }
        }
        return;
      }
      if (typeof record.id !== 'number') return;
      const entry = pending.get(record.id);
      if (!entry) return;
      pending.delete(record.id);
      if (record.error) {
        const code = (
          typeof record.error.code === 'string' ? record.error.code : 'internal'
        ) as ControlErrorCode;
        const message =
          typeof record.error.message === 'string' ? record.error.message : 'control request failed';
        entry.reject(new ControlRequestError(message, code));
        return;
      }
      entry.resolve(record.result);
    }

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          try {
            handleFrame(JSON.parse(line));
          } catch {
            // Ignore malformed frames from the server.
          }
        }
        newline = buffer.indexOf('\n');
      }
    });

    socket.on('error', (error: Error) => {
      if (!connected) {
        clearTimeout(connectTimer);
        rejectConnect(error);
        return;
      }
      failPending(error);
    });

    socket.on('close', () => {
      failPending(new Error('control socket closed'));
      resolveClosed();
    });

    const client: ControlClient = {
      request(method, params) {
        return new Promise((resolve, reject) => {
          if (socket.destroyed || !socket.writable) {
            reject(new Error('control socket is not connected'));
            return;
          }
          const id = nextId++;
          pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
          socket.write(`${JSON.stringify({ id, method, params })}\n`);
        });
      },

      on(event, handler) {
        let handlers = listeners.get(event);
        if (!handlers) {
          handlers = new Set();
          listeners.set(event, handlers);
        }
        handlers.add(handler as (data: never) => void);
      },

      off(event, handler) {
        listeners.get(event)?.delete(handler as (data: never) => void);
      },

      async subscribe(events) {
        const result = await client.request('subscribe', events ? { events } : {});
        return result.subscribed;
      },

      close() {
        socket.destroy();
      },

      closed,
    };

    socket.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      resolveConnect(client);
    });
  });
}
