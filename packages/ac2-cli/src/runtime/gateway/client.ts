/**
 * Minimal JSON-RPC client for the OpenClaw Gateway control plane, over a
 * {@link GatewayConnection}. Implements exactly the wire envelopes and
 * connect handshake documented for protocol v4 — see the module-level
 * comment in `adapter.ts` for the broader picture of what this is used for.
 *
 * The handshake is challenge–response: the Gateway pushes a
 * `connect.challenge` event as soon as the socket opens, and the `connect`
 * request answers it with a device signature over that nonce (see
 * `device-identity.ts`). That signature is what makes the Gateway BIND the
 * requested operator scopes to this daemon; an unsigned connect is accepted
 * but silently stripped of them, which shows up as `missing scope: …` on
 * every later RPC. The granted scopes are therefore verified here before
 * `ready` resolves.
 *
 * This is intentionally NOT a general-purpose RPC library: it knows nothing
 * about the Gateway's actual methods (`agent`, `agent.wait`,
 * `sessions.messages.subscribe`, …) — that knowledge lives in `adapter.ts`.
 */

import type { GatewayConnection } from './connection.js';
import {
  buildDeviceConnectParams,
  type DeviceConnectParams,
  type GatewayDeviceIdentity,
} from './device-identity.js';

/** Gateway protocol version this client speaks (see `ConnectParamsSchema`). */
export const GATEWAY_PROTOCOL_VERSION = 4;

/**
 * Operator scopes this adapter needs: `operator.read` for the session/history
 * subscriptions, `operator.write` to start agent runs. Requested on connect
 * AND verified against what `hello-ok` actually granted (see
 * {@link missingScopes}) — a Gateway may hand back FEWER scopes than asked
 * for, and does so silently.
 */
export const REQUIRED_OPERATOR_SCOPES = ['operator.read', 'operator.write'] as const;

/** `operator.admin` is a superset the Gateway accepts for every operator scope. */
const OPERATOR_ADMIN_SCOPE = 'operator.admin';

/** The Gateway role this adapter connects as (`operator` | `node`). */
export const GATEWAY_ROLE = 'operator';

/**
 * Which of `required` are NOT covered by `granted`. Mirrors the Gateway's own
 * check: `operator.admin` satisfies everything, and `operator.write` also
 * satisfies `operator.read`.
 */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  if (granted.includes(OPERATOR_ADMIN_SCOPE)) return [];
  return required.filter((scope) => {
    if (granted.includes(scope)) return false;
    return !(scope === 'operator.read' && granted.includes('operator.write'));
  });
}

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
  /**
   * Signer used to answer the connect challenge — in the daemon, the AC2
   * service key. WITHOUT it the Gateway treats the requested scopes as
   * unbound and (depending on version and locality) silently drops them —
   * the handshake still succeeds, but every later RPC fails
   * `missing scope: …`. See `device-identity.ts`.
   */
  deviceIdentity?: GatewayDeviceIdentity;
  /**
   * Device token previously issued to {@link deviceIdentity} (`hello-ok.auth.
   * deviceToken`). Sent as `auth.deviceToken` so a paired daemon still
   * authenticates when no shared token is configured.
   */
  deviceToken?: string;
  /** Scopes to request; defaults to {@link REQUIRED_OPERATOR_SCOPES}. */
  scopes?: readonly string[];
  /**
   * Scopes the handshake must actually grant, else `ready` rejects rather
   * than handing back a connection whose every RPC is denied. Defaults to the
   * requested scopes.
   */
  requiredScopes?: readonly string[];
  /** Called when `hello-ok` carries a (re)issued device token, for persistence. */
  onDeviceToken?: (token: string, scopes: string[] | undefined) => void;
}

export interface GatewayClient {
  /** Resolves once the `connect` handshake completes (`hello-ok` received). */
  readonly ready: Promise<void>;
  /** Scopes `hello-ok` actually granted; empty until the handshake completes. */
  readonly grantedScopes: readonly string[];
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
 * How long to wait for the Gateway's `connect.challenge` event before giving
 * up on signing a device identity and connecting without one. The event is
 * pushed as soon as the socket opens, so this only ever fires against a
 * server (or mock) that does not implement the challenge at all — in which
 * case an unsigned connect is strictly better than hanging.
 */
const CONNECT_CHALLENGE_TIMEOUT_MS = 2000;

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

  const requestedScopes = [...(opts.scopes ?? REQUIRED_OPERATOR_SCOPES)];
  const requiredScopes = [...(opts.requiredScopes ?? requestedScopes)];
  let grantedScopes: string[] = [];

  const clientId = 'cli' satisfies GatewayClientId;
  const clientMode = 'cli' satisfies GatewayClientMode;
  const role = GATEWAY_ROLE;

  let connectSent = false;
  let challengeTimer: NodeJS.Timeout | null = null;

  /**
   * Send the one-and-only `connect` request. `nonce` comes from the Gateway's
   * `connect.challenge` event; without it (no device identity configured, or
   * a server that never challenges) the request goes out unsigned.
   *
   * Async because signing goes through the keystore (the service key is
   * non-extractable and may live behind an OS keychain). `connectSent` is set
   * SYNCHRONOUSLY so a challenge arriving mid-signature cannot start a second
   * handshake.
   */
  async function sendConnect(nonce: string | null): Promise<void> {
    if (connectSent) return;
    connectSent = true;
    if (challengeTimer) {
      clearTimeout(challengeTimer);
      challengeTimer = null;
    }
    // The shared token is what the device signature commits to when present;
    // otherwise the device token stands in for it (mirrors the Gateway
    // client's `resolveSignatureToken`).
    const signatureToken = opts.token ?? opts.deviceToken ?? null;
    const auth: Record<string, unknown> = {
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.deviceToken ? { deviceToken: opts.deviceToken } : {}),
    };
    let device: DeviceConnectParams | undefined;
    if (opts.deviceIdentity && nonce !== null) {
      try {
        device = await buildDeviceConnectParams({
          identity: opts.deviceIdentity,
          clientId,
          clientMode,
          role,
          scopes: requestedScopes,
          signatureToken,
          nonce,
          platform: process.platform,
        });
      } catch (err) {
        // The keystore could not sign (locked keychain, missing service key).
        // Connecting unsigned is still worth a try — some deployments accept
        // unbound operator sessions — and the scope check below reports it
        // precisely if this one does not.
        log(
          '[ac2][openclaw-gateway] could not sign the gateway connect challenge with the AC2 ' +
            `service key (${(err as Error).message}); connecting without a device identity.`,
        );
      }
    } else if (opts.deviceIdentity) {
      log(
        '[ac2][openclaw-gateway] no connect.challenge from the gateway — connecting without a ' +
          'device identity; the gateway may refuse to grant operator scopes.',
      );
    }
    // The socket may have closed (or the handshake otherwise failed) while the
    // signature was being produced.
    if (readySettled) return;
    const connectParams: Record<string, unknown> = {
      minProtocol: GATEWAY_PROTOCOL_VERSION,
      maxProtocol: GATEWAY_PROTOCOL_VERSION,
      client: {
        id: clientId,
        version: '1.0.0',
        platform: process.platform,
        mode: clientMode,
      },
      role,
      scopes: requestedScopes,
      ...(Object.keys(auth).length > 0 ? { auth } : {}),
      ...(device ? { device } : {}),
    };
    const frame: RequestFrame = { type: 'req', id: connectId, method: 'connect', params: connectParams };
    connection.send(JSON.stringify(frame));
  }

  connection.onOpen(() => {
    // With a device identity the connect frame CANNOT be built yet: its
    // signature has to cover the challenge nonce the Gateway is about to
    // push. Without one there is nothing to wait for, so connect right away
    // (also keeps the handshake single-round-trip for simple/mocked servers).
    if (!opts.deviceIdentity) {
      void sendConnect(null);
      return;
    }
    challengeTimer = setTimeout(() => {
      challengeTimer = null;
      void sendConnect(null);
    }, CONNECT_CHALLENGE_TIMEOUT_MS);
  });

  /**
   * Finish the handshake from a `hello-ok`, VERIFYING the scopes it granted.
   *
   * The Gateway answers `ok:true` even when it granted nothing at all: an
   * operator connect with valid shared auth but no device identity is
   * accepted and then stripped of its unbound scopes. Treating that as
   * success is what turned a permissions problem into a stream of
   * `missing scope: operator.read` failures on every later call, so a
   * handshake that does not carry the scopes this adapter needs is failed
   * here, loudly and once.
   */
  function completeHandshake(payload: unknown): void {
    const auth = isRecord(payload) && isRecord(payload['auth']) ? payload['auth'] : undefined;
    const scopes = Array.isArray(auth?.['scopes'])
      ? (auth['scopes'] as unknown[]).filter((scope): scope is string => typeof scope === 'string')
      : [];
    grantedScopes = scopes;

    const deviceToken = auth?.['deviceToken'];
    if (typeof deviceToken === 'string' && deviceToken.length > 0) {
      opts.onDeviceToken?.(deviceToken, scopes.length > 0 ? scopes : undefined);
    }

    // No `auth` block at all → a server (or mock) that does not report grants;
    // nothing to verify, so trust the `ok:true`.
    const missing = auth ? missingScopes(scopes, requiredScopes) : [];
    if (missing.length > 0) {
      settleReadyErr(
        `gateway granted scopes [${scopes.join(', ') || 'none'}] but ${missing.join(', ')} ` +
          'is required. The gateway only binds requested scopes to a PAIRED DEVICE: check that ' +
          'this daemon is approved (`openclaw devices`) and that the shared gateway token it ' +
          'uses (`gateway.auth.token` / OPENCLAW_GATEWAY_TOKEN) matches the running gateway.',
      );
      return;
    }
    settleReadyOk();
  }

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
      completeHandshake(frame);
      return;
    }

    if (frame.type === 'res') {
      const res = frame as ResponseFrame;
      // The `connect` handshake is answered as an ordinary `res` correlated to
      // the connect request id — NOT registered in `pending` (it is sent
      // directly in `onOpen`, not via `request()`). Confirmed against a live
      // Gateway (protocol v4, server 2026.7.1-x): a successful handshake is
      // `{ ok:true, payload:{ type:'hello-ok', protocol, server, features,
      // auth:{ role, scopes, deviceToken? }, … } }` — preceded by the
      // `connect.challenge` event whose nonce the device signature answers —
      // and a rejected one is `{ ok:false, error }` (e.g.
      // `NOT_PAIRED`/`DEVICE_IDENTITY_REQUIRED` when no valid `auth.token`).
      if (res.id === connectId) {
        if (res.ok) completeHandshake(res.payload);
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
      // The challenge carries the nonce the device signature must cover — it
      // is what unblocks the connect frame (see `sendConnect`).
      if (evt.event === 'connect.challenge' && !connectSent) {
        const nonce = isRecord(evt.payload) ? evt.payload['nonce'] : undefined;
        void sendConnect(typeof nonce === 'string' && nonce.length > 0 ? nonce : null);
      }
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
    if (challengeTimer) {
      clearTimeout(challengeTimer);
      challengeTimer = null;
    }
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
    get grantedScopes(): readonly string[] {
      return grantedScopes;
    },
    request,
    onEvent(cb: (event: string, payload: unknown) => void): void {
      eventHandlers.push(cb);
    },
    close(): void {
      connection.close();
    },
  };
}
