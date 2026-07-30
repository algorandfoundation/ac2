/**
 * Minimal JSON-RPC client for the OpenClaw Gateway control plane, over a
 * {@link GatewayConnection}. Implements exactly the wire envelopes and
 * connect handshake documented for protocol v4 — see the module-level
 * comment in `adapter.ts` for the broader picture of what this is used for.
 *
 * This is intentionally NOT a general-purpose RPC library: it knows nothing
 * about the Gateway's actual methods (`agent`, `agent.wait`,
 * `sessions.messages.subscribe`, …) — that knowledge lives in `adapter.ts`.
 */

import type { GatewayConnection } from './connection.js';

/** Gateway protocol version this client speaks (see `ConnectParamsSchema`). */
export const GATEWAY_PROTOCOL_VERSION = 4;

/** One outbound `req` envelope. */
interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

/** The `error` shape nested in a `res` envelope, verbatim from the schema. */
export interface GatewayRpcErrorPayload {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}

/** One inbound `res` envelope. */
interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: GatewayRpcErrorPayload;
}

/** One inbound `event` envelope. */
interface EventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
}

/** Any frame received over the wire, before it has been classified. */
type InboundFrame =
  | ResponseFrame
  | EventFrame
  | { type: 'hello-ok'; protocol?: number; server?: unknown; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

/** Error thrown when a Gateway `res` frame carries `ok: false`. */
export class GatewayRpcError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly retryable: boolean | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(error: GatewayRpcErrorPayload) {
    super(error.message);
    this.name = 'GatewayRpcError';
    this.code = error.code;
    this.details = error.details;
    this.retryable = error.retryable;
    this.retryAfterMs = error.retryAfterMs;
  }
}

/** The closed set of `client.id` values the Gateway's `ConnectParamsSchema` accepts. */
type GatewayClientId = 'cli';

/** The closed set of `client.mode` values the Gateway's `ConnectParamsSchema` accepts. */
type GatewayClientMode = 'cli';

export interface GatewayClientOptions {
  connection: GatewayConnection;
  log: (line: string) => void;
  /** Bearer token sent as `auth.token`; omitted entirely when absent. */
  token?: string;
}

export interface GatewayClient {
  /** Resolves once the `connect` handshake completes (`hello-ok` received). */
  readonly ready: Promise<void>;
  /** Issue one RPC call; resolves `payload`, rejects with {@link GatewayRpcError} on `ok:false`. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** Register a handler for every `event` frame the Gateway pushes. */
  onEvent(cb: (event: string, payload: unknown) => void): void;
  /** Close the underlying connection. */
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseFrame(raw: string): InboundFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed['type'] !== 'string') return null;
    return parsed as unknown as InboundFrame;
  } catch {
    return null;
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

/**
 * Construct a Gateway RPC client over an already-injectable
 * {@link GatewayConnection}. The connect handshake is kicked off
 * immediately; callers await {@link GatewayClient.ready} before issuing
 * requests other than the implicit `connect` itself.
 */
export function createGatewayClient(opts: GatewayClientOptions): GatewayClient {
  const { connection, log } = opts;

  const pending = new Map<
    string,
    { resolve: (payload: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  const eventHandlers: Array<(event: string, payload: unknown) => void> = [];

  let nextId = 1;
  function freshId(): string {
    return `ac2-${nextId++}-${Math.random().toString(36).slice(2, 8)}`;
  }

  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let readySettled = false;

  const connectId = freshId();
  const connectTimer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new Error('[ac2][openclaw-gateway] gateway connect handshake timed out'));
  }, DEFAULT_CONNECT_TIMEOUT_MS);

  function settleReadyOk(): void {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(connectTimer);
    resolveReady();
  }

  function settleReadyErr(message: string): void {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(connectTimer);
    rejectReady(new Error(`[ac2][openclaw-gateway] gateway connect failed: ${message}`));
  }

  connection.onOpen(() => {
    const connectParams: Record<string, unknown> = {
      minProtocol: GATEWAY_PROTOCOL_VERSION,
      maxProtocol: GATEWAY_PROTOCOL_VERSION,
      client: {
        id: 'cli' satisfies GatewayClientId,
        version: '1.0.0',
        platform: process.platform,
        mode: 'cli' satisfies GatewayClientMode,
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      ...(opts.token ? { auth: { token: opts.token } } : {}),
    };
    const frame: RequestFrame = { type: 'req', id: connectId, method: 'connect', params: connectParams };
    connection.send(JSON.stringify(frame));
  });

  connection.onMessage((raw) => {
    const frame = parseFrame(raw);
    if (!frame) {
      log(`[ac2][openclaw-gateway] ignoring unparsable gateway frame: ${raw.slice(0, 200)}`);
      return;
    }

    // A top-level `hello-ok` frame is NOT what the real Gateway sends (it
    // wraps `hello-ok` in the `res` to the `connect` request — see below);
    // this branch is kept only as a tolerant fallback for any server/mock
    // that emits it directly.
    if (frame.type === 'hello-ok') {
      settleReadyOk();
      return;
    }

    if (frame.type === 'res') {
      const res = frame as ResponseFrame;
      // The `connect` handshake is answered as an ordinary `res` correlated to
      // the connect request id — NOT registered in `pending` (it is sent
      // directly in `onOpen`, not via `request()`). Confirmed against a live
      // Gateway (protocol v4, server 2026.7.1-x): a successful handshake is
      // `{ ok:true, payload:{ type:'hello-ok', protocol, server, features, … } }`
      // (preceded by a `connect.challenge` event, which token auth does not
      // need to answer), and a rejected one is `{ ok:false, error }` (e.g.
      // `NOT_PAIRED`/`DEVICE_IDENTITY_REQUIRED` when no valid `auth.token`).
      if (res.id === connectId) {
        if (res.ok) settleReadyOk();
        else settleReadyErr(res.error?.message ?? 'connect request rejected');
        return;
      }
      const waiter = pending.get(res.id);
      if (!waiter) return;
      pending.delete(res.id);
      clearTimeout(waiter.timer);
      if (res.ok) waiter.resolve(res.payload);
      else waiter.reject(new GatewayRpcError(res.error ?? { code: 'unknown', message: 'request failed' }));
      return;
    }

    if (frame.type === 'event') {
      const evt = frame as EventFrame;
      for (const handler of eventHandlers) {
        try {
          handler(evt.event, evt.payload);
        } catch (err) {
          log(`[ac2][openclaw-gateway] event handler threw: ${(err as Error).message}`);
        }
      }
      return;
    }

    // Any other early frame type at connect time is treated as a handshake
    // failure so `ready` never hangs forever on an unexpected reply.
    if (!readySettled) {
      settleReadyErr(`unexpected frame type "${frame.type}" before hello-ok`);
    }
  });

  connection.onClose((reason) => {
    settleReadyErr(`connection closed before handshake completed (${reason})`);
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`[ac2][openclaw-gateway] connection closed (${reason})`));
      pending.delete(id);
    }
  });

  function request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const id = freshId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`[ac2][openclaw-gateway] request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (payload: unknown) => void, reject, timer });
      const frame: RequestFrame = { type: 'req', id, method, ...(params !== undefined ? { params } : {}) };
      connection.send(JSON.stringify(frame));
    });
  }

  return {
    ready,
    request,
    onEvent(cb: (event: string, payload: unknown) => void): void {
      eventHandlers.push(cb);
    },
    close(): void {
      connection.close();
    },
  };
}
