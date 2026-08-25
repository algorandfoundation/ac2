/**
 * NDJSON control-socket server used by the AC2 daemon.
 *
 * Listens on a Unix domain socket (named pipe on Windows), parses one JSON
 * request per line, dispatches to a caller-provided handler, and pushes
 * `{ event, data }` notifications to subscribed clients. See
 * {@link ../control/protocol.ts} for the wire format.
 */

import { createServer, connect, type Server, type Socket } from 'node:net';
import { chmod, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  isControlMethod,
  resolveControlSocketPath,
  type ControlErrorCode,
  type ControlEventName,
  type ControlEvents,
} from './protocol.js';

/** Per-socket state tracked by the server for routing and cleanup. */
export interface ControlClientConnection {
  /** Monotonic id assigned at accept time. */
  id: number;
  /** Events this client asked to receive via the `subscribe` method. */
  subscriptions: Set<ControlEventName>;
  /** Agent id registered via `agent.hello`, if any. */
  agent: string | null;
  /** Underlying socket (used by the server to write frames). */
  socket: Socket;
}

/** Request dispatcher; the returned value becomes the `result` payload. */
export type ControlRequestHandler = (
  client: ControlClientConnection,
  method: string,
  params: unknown,
) => unknown | Promise<unknown>;

export interface ControlServerOptions {
  /** Socket path; defaults to {@link resolveControlSocketPath}. */
  path?: string;
  handler: ControlRequestHandler;
  /** Invoked after a client socket closes (for agent cleanup). */
  onClientClosed?: (client: ControlClientConnection) => void;
}

export interface ControlServer {
  /** Bind the socket; resolves with the listening path. */
  listen(): Promise<string>;
  /** Close all client sockets and stop listening. */
  close(): Promise<void>;
  /** Push an event to every subscribed client (optionally filtered). */
  broadcast<E extends ControlEventName>(
    event: E,
    data: ControlEvents[E],
    filter?: (client: ControlClientConnection) => boolean,
  ): void;
  /** Push an event to a single client regardless of subscriptions. */
  sendEvent<E extends ControlEventName>(
    client: ControlClientConnection,
    event: E,
    data: ControlEvents[E],
  ): void;
  /** Snapshot of currently connected clients. */
  clients(): ControlClientConnection[];
}

const KNOWN_ERROR_CODES: readonly string[] = [
  'bad_request',
  'not_connected',
  'pairing_active',
  'agent_taken',
  'not_found',
  'internal',
];

function toErrorCode(error: unknown): ControlErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && KNOWN_ERROR_CODES.includes(code)) {
    return code as ControlErrorCode;
  }
  return 'internal';
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isWindowsPipe(path: string): boolean {
  return process.platform === 'win32' || path.startsWith('\\\\.\\pipe\\');
}

/**
 * Probe an existing socket file: resolves `true` when another daemon answers,
 * `false` when the file is stale (connection refused / timed out).
 */
function probeSocket(path: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (alive: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Create (but do not start) a control-socket server. */
export function createControlServer(options: ControlServerOptions): ControlServer {
  const path = options.path ?? resolveControlSocketPath();
  const clients = new Set<ControlClientConnection>();
  let nextClientId = 1;
  let server: Server | null = null;

  function writeFrame(socket: Socket, frame: unknown): void {
    if (socket.destroyed || !socket.writable) return;
    socket.write(`${JSON.stringify(frame)}\n`);
  }

  function sendError(socket: Socket, id: number, code: ControlErrorCode, message: string): void {
    writeFrame(socket, { id, error: { code, message } });
  }

  async function dispatch(client: ControlClientConnection, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed JSON: try to recover an id so the peer is not left hanging.
      const match = /"id"\s*:\s*(\d+)/.exec(line);
      if (match) sendError(client.socket, Number(match[1]), 'bad_request', 'malformed JSON frame');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const frame = parsed as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof frame.id !== 'number') return;
    const id = frame.id;
    if (typeof frame.method !== 'string' || !isControlMethod(frame.method)) {
      sendError(client.socket, id, 'bad_request', `unknown method: ${String(frame.method)}`);
      return;
    }
    try {
      const result = await options.handler(client, frame.method, frame.params ?? {});
      writeFrame(client.socket, { id, result: result ?? {} });
    } catch (error) {
      sendError(client.socket, id, toErrorCode(error), toErrorMessage(error));
    }
  }

  function onConnection(socket: Socket): void {
    const client: ControlClientConnection = {
      id: nextClientId++,
      subscriptions: new Set(),
      agent: null,
      socket,
    };
    clients.add(client);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) void dispatch(client, line);
        newline = buffer.indexOf('\n');
      }
    });
    const cleanup = (): void => {
      if (!clients.has(client)) return;
      clients.delete(client);
      options.onClientClosed?.(client);
    };
    socket.on('close', cleanup);
    socket.on('error', () => socket.destroy());
  }

  async function prepareSocketPath(): Promise<void> {
    if (isWindowsPipe(path)) return;
    await mkdir(dirname(path), { recursive: true });
    let exists = false;
    try {
      await stat(path);
      exists = true;
    } catch {
      // no socket file: nothing to clean up
    }
    if (!exists) return;
    if (await probeSocket(path)) {
      throw new Error(`daemon already running (socket in use: ${path})`);
    }
    await unlink(path);
  }

  return {
    async listen(): Promise<string> {
      if (server) throw new Error('control server already listening');
      await prepareSocketPath();
      const netServer = createServer(onConnection);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        netServer.once('error', onError);
        netServer.listen(path, () => {
          netServer.off('error', onError);
          resolve();
        });
      });
      server = netServer;
      if (!isWindowsPipe(path)) {
        await chmod(path, 0o600);
      }
      return path;
    },

    async close(): Promise<void> {
      const netServer = server;
      server = null;
      for (const client of [...clients]) {
        client.socket.destroy();
      }
      clients.clear();
      if (!netServer) return;
      await new Promise<void>((resolve) => {
        netServer.close(() => resolve());
      });
    },

    broadcast(event, data, filter) {
      for (const client of clients) {
        if (!client.subscriptions.has(event)) continue;
        if (filter && !filter(client)) continue;
        writeFrame(client.socket, { event, data });
      }
    },

    sendEvent(client, event, data) {
      writeFrame(client.socket, { event, data });
    },

    clients(): ControlClientConnection[] {
      return [...clients];
    },
  };
}
