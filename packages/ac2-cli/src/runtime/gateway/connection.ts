/**
 * Transport seam between the Gateway JSON-RPC client (`client.ts`) and the
 * actual wire. Kept as a tiny interface — rather than having `client.ts`
 * reach for `WebSocket` directly — so the client (and, transitively, the
 * `openclaw-gateway` adapter) can be unit-tested with a fake in-process
 * connection, with no WebSocket server anywhere in the test process.
 */

/**
 * A bidirectional, text-message connection to the OpenClaw Gateway. Callback
 * registration (rather than an `EventTarget`/`EventEmitter`) keeps the
 * fake-for-tests implementation trivial — a handful of arrays, no DOM/Node
 * event-emitter semantics to fake.
 */
export interface GatewayConnection {
  /** Send one text frame. */
  send(data: string): void;
  /** Close the connection (best-effort; never throws). */
  close(): void;
  /** Register a handler for each inbound text frame. */
  onMessage(cb: (data: string) => void): void;
  /** Register a handler fired once the connection closes (for any reason). */
  onClose(cb: (reason: string) => void): void;
  /** Register a handler fired once the connection is open and ready to send. */
  onOpen(cb: () => void): void;
}

/**
 * Minimal shape of the WHATWG `WebSocket` this module actually uses. Defined
 * locally rather than referencing the ambient `WebSocket`/`MessageEvent`/
 * `CloseEvent` DOM types: this workspace's `tsconfig.json` targets `lib:
 * ["ES2022"]` (no `"dom"`) and the installed `@types/node` version does not
 * ship the global `WebSocket` typing either, so those names are not
 * guaranteed to resolve. The runtime object (Node ≥22's global `WebSocket`)
 * has always implemented this shape regardless of which `@types/*` package
 * happens to be installed.
 */
interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void;
}

type MinimalWebSocketCtor = new (url: string) => MinimalWebSocket;

/**
 * Wrap the Node global `WebSocket` (available on Node ≥22, and the daemon
 * targets Node 24 — see `packages/ac2-cli/scripts/bundle.mjs`) as a
 * {@link GatewayConnection}. Deliberately does NOT depend on the `ws` npm
 * package: the whole point of using the global is to avoid a new runtime
 * dependency for a single opt-in adapter.
 */
export function createWebSocketConnection(url: string): GatewayConnection {
  const WebSocketCtor = (globalThis as { WebSocket?: unknown }).WebSocket as
    | MinimalWebSocketCtor
    | undefined;
  if (typeof WebSocketCtor !== 'function') {
    throw new Error(
      '[ac2][openclaw-gateway] no global WebSocket is available in this runtime; the ' +
        '"openclaw-gateway" adapter requires Node 22+ (the daemon targets Node 24).',
    );
  }

  const socket = new WebSocketCtor(url);

  return {
    send(data: string): void {
      socket.send(data);
    },
    close(): void {
      try {
        socket.close();
      } catch {
        // best-effort — the socket may already be closed/closing.
      }
    },
    onMessage(cb: (data: string) => void): void {
      socket.addEventListener('message', (event) => {
        // Gateway frames are always text; anything else is not a valid frame
        // and is silently ignored rather than crashing the listener.
        if (typeof event.data === 'string') cb(event.data);
      });
    },
    onClose(cb: (reason: string) => void): void {
      socket.addEventListener('close', (event) => {
        cb(event.reason && event.reason.length > 0 ? event.reason : `closed (code ${event.code})`);
      });
    },
    onOpen(cb: () => void): void {
      socket.addEventListener('open', () => cb());
    },
  };
}
