/**
 * Liquid Auth `Ac2ChannelProvider`. Requests the AC2 channels by spec label
 * (`ac2-v1`, `ac2-stream`) and hands the control channel to `Ac2Client` via
 * `rtcDataChannelTransport`. A third `ac2-heartbeat` DataChannel is also
 * negotiated but kept fully out-of-band: it is pinged inside this provider
 * for liveness and never exposed on the returned `Ac2PairedChannel`.
 *
 * This provider's runtime dependencies (`@roamhq/wrtc`, `socket.io-client`,
 * `@algorandfoundation/liquid-client`) are all Node-only and heavy (native
 * bindings, a full socket.io client, a compiled signaling SDK), so they are
 * declared as `optionalDependencies` and loaded via dynamic `import()` only
 * once `startPairing()` actually runs. Importing this module — or any other
 * SDK entry point — never loads them; a missing package surfaces as a clear,
 * actionable error (see `importOptionalDependency`) instead of a raw
 * `ERR_MODULE_NOT_FOUND`.
 */

import type {
  Ac2ChannelProvider,
  Ac2PairedChannel,
  Ac2PairingHandle,
  Ac2PairingInfo,
  Ac2StartPairingOptions,
} from '../signaling/index.js';
import { rtcDataChannelTransport, type Ac2Transport } from '../transport/index.js';
import { normalizeDidKey } from '../signaling/did.js';

let webRtcPolyfillReady: Promise<void> | undefined;

/**
 * Dynamically import an optional runtime dependency, turning a missing
 * package into a clear, actionable error (naming the exact package to
 * install) instead of a raw `ERR_MODULE_NOT_FOUND`. `installName` lets a
 * subpath specifier (e.g. `@algorandfoundation/liquid-client/signal`) report
 * the installable package name instead of the subpath itself.
 */
async function importOptionalDependency<T>(specifier: string, installName = specifier): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (err) {
    throw new Error(
      `[ac2-sdk] LiquidAuthChannelProvider requires the optional package "${installName}", which ` +
        `is not installed. Install it with: npm install ${installName}\n\n` +
        `Original error: ${(err as Error).message}`,
    );
  }
}

async function importSocketIoClient(): Promise<typeof import('socket.io-client')> {
  return importOptionalDependency<typeof import('socket.io-client')>('socket.io-client');
}

async function importSignalClient(): Promise<{ SignalClient: any }> {
  return importOptionalDependency<{ SignalClient: any }>(
    // Compiled JS in node_modules; this subpath has no published type
    // declarations, hence the `any` above rather than a `@ts-ignore` on a
    // dynamic (non-literal-adjacent) import.
    '@algorandfoundation/liquid-client/signal',
    '@algorandfoundation/liquid-client',
  );
}

async function ensureWebRtcPolyfill(): Promise<void> {
  if (typeof (globalThis as any).RTCPeerConnection !== 'undefined') return;
  webRtcPolyfillReady ??= (async () => {
    // @roamhq/wrtc: libwebrtc-backed Node WebRTC bindings, shipped as prebuilt
    // platform binaries. Import lazily so plugin discovery/CLI startup does not
    // require loading the native module.
    const wrtc: any = await importOptionalDependency<any>('@roamhq/wrtc');
    const rtc = wrtc.default ?? wrtc;

    // Subclass RTCPeerConnection to queue remote ICE candidates that arrive via
    // trickle before setRemoteDescription completes. The Liquid Auth SignalClient
    // can race between trickling candidates and the offer/answer exchange, and
    // adding a candidate before the remote description is set can throw instead
    // of buffering silently.
    class Ac2RTCPeerConnection extends rtc.RTCPeerConnection {
      private _ac2PendingCandidates: any[] = [];
      private _ac2RemoteDescReady = false;

      async setRemoteDescription(desc: any): Promise<void> {
        this._ac2RemoteDescReady = false;
        await super.setRemoteDescription(desc);
        this._ac2RemoteDescReady = true;
        const queued = this._ac2PendingCandidates.splice(0);
        for (const c of queued) {
          try {
            await super.addIceCandidate(c);
          } catch {
            // Stale or invalid candidate after drain — safe to ignore.
          }
        }
      }

      async addIceCandidate(candidate: any): Promise<void> {
        if (!this._ac2RemoteDescReady) {
          this._ac2PendingCandidates.push(candidate);
          return;
        }
        return super.addIceCandidate(candidate);
      }
    }

    (globalThis as any).RTCPeerConnection = Ac2RTCPeerConnection;
    (globalThis as any).RTCIceCandidate = rtc.RTCIceCandidate;
    (globalThis as any).RTCSessionDescription = rtc.RTCSessionDescription;
    if (rtc.RTCDataChannel) {
      (globalThis as any).RTCDataChannel = rtc.RTCDataChannel;
    }
  })();
  await webRtcPolyfillReady;
}

// STUN/TURN mirrored from the AC2 Controller app's answer side.
const AC2_ICE_CONFIG: any = {
  iceServers: [
    {
      urls: ['stun:geo.turn.algonode.xyz:80', 'stun:global.turn.nodely.io:443'],
    },
    {
      urls: [
        'turn:geo.turn.algonode.xyz:80?transport=tcp',
        'turns:global.turn.nodely.io:443?transport=tcp',
      ],
      username: 'liquid-auth',
      credential: 'sqmcP4MiTKMT4TGEDSk9jgHY',
    },
  ],
  iceCandidatePoolSize: 10,
};

const AC2_HEARTBEAT_MS = 20000;
/**
 * Treat the peer as gone if we receive no `ac2-heartbeat` traffic for this
 * long. 2.5× the send interval tolerates one missed round-trip plus jitter.
 */
const AC2_DEFAULT_HEARTBEAT_TIMEOUT_MS = AC2_HEARTBEAT_MS * 2.5;
/** Default ceiling for awaiting the signaling socket's initial `connect`. */
const AC2_DEFAULT_PAIRING_TIMEOUT_MS = 120_000;
/**
 * Once the signaling socket goes down mid-handshake, give socket.io's own
 * reconnection this long to recover before treating it as a genuine
 * ping-timeout/network failure. Deliberately independent of how long the
 * human takes to scan/approve — that phase has no ceiling of its own.
 */
const AC2_DEFAULT_SIGNAL_DEAD_TIMEOUT_MS = 45_000;
/** Poll interval for the wall-clock wake detector (see `startPairing`). */
const AC2_WAKE_CHECK_INTERVAL_MS = 10_000;
/**
 * If the wall clock jumps more than this between wake-detector ticks, the
 * process was almost certainly suspended (OS sleep). Node timers run on the
 * monotonic clock and pause during suspend, so after a resume socket.io can
 * sit in its reconnect backoff while the network is already back — the
 * detector kicks `socket.connect()` immediately instead.
 */
const AC2_WAKE_JUMP_THRESHOLD_MS = AC2_WAKE_CHECK_INTERVAL_MS * 3;
const AC2_CONTROL_LABEL = 'ac2-v1' as const;
const AC2_STREAM_LABEL = 'ac2-stream' as const;
/** Dedicated liveness channel — keeps keepalive off the control plane. */
const AC2_HEARTBEAT_LABEL = 'ac2-heartbeat' as const;
const AC2_HEARTBEAT_PING = 'ping' as const;
const AC2_HEARTBEAT_PONG = 'pong' as const;

export function closeRtcDataChannel(channel: unknown): void {
  if (
    channel &&
    typeof (channel as { close?: unknown }).close === 'function' &&
    (channel as { readyState?: unknown }).readyState !== 'closed'
  ) {
    try {
      (channel as { close: () => void }).close();
    } catch {
      // Already closing/closed; ignore.
    }
  }
}

export function closeAwareTransport(base: Ac2Transport): {
  transport: Ac2Transport;
  emitClose: () => void;
} {
  const closeHandlers = new Set<() => void>();
  let closeEmitted = false;

  const emitClose = (): void => {
    if (closeEmitted) return;
    closeEmitted = true;
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch {
        // Close notifications are best-effort; keep notifying the rest.
      }
    }
    closeHandlers.clear();
  };

  base.onClose(emitClose);

  const transport: Ac2Transport = {
    send: (payload) => base.send(payload),
    onMessage: (handler) => base.onMessage(handler),
    onRawMessage: (handler) => base.onRawMessage?.(handler),
    onBinaryMessage: (handler) => base.onBinaryMessage?.(handler),
    onError: (handler) => base.onError(handler),
    onOpen: (handler) => base.onOpen(handler),
    onClose: (handler) => {
      if (closeEmitted) {
        handler();
        return;
      }
      closeHandlers.add(handler);
    },
    close: () => {
      try {
        base.close();
      } finally {
        emitClose();
      }
    },
    get isOpen() {
      return base.isOpen;
    },
  };

  return { transport, emitClose };
}

export function resolveHeartbeatTimeoutMs(value?: string): number {
  if (value === undefined || value.trim().length === 0) return AC2_DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const parsed = Number(value);
  const minimum = AC2_HEARTBEAT_MS * 2;
  return Number.isFinite(parsed) && parsed >= minimum
    ? parsed
    : AC2_DEFAULT_HEARTBEAT_TIMEOUT_MS;
}

/** Raised when the signaling socket never reaches `connect` in time. */
export class SignalingConnectError extends Error {
  readonly code: 'timeout' | 'aborted';
  constructor(code: 'timeout' | 'aborted', message: string) {
    super(message);
    this.name = 'SignalingConnectError';
    this.code = code;
  }
}

/**
 * Await the signaling socket's first `connect`, bounded by `timeoutMs` and an
 * optional abort `signal`. On timeout or abort, invokes `onFailure` (used to
 * tear down the socket so it stops retrying) and rejects — so callers never
 * block forever on an unreachable signaling server. A successful `connect`
 * clears the timer and detaches the abort listener; later duplicate `connect`
 * events (or an elapsed timer) are no-ops.
 */
export function awaitSignalConnect(
  client: { on: (event: string, listener: (...args: any[]) => void) => void },
  opts: { timeoutMs: number; signal?: AbortSignal; onFailure?: () => void },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const fail = (error: SignalingConnectError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        opts.onFailure?.();
      } catch {
        // Teardown is best-effort; still reject the caller.
      }
      reject(error);
    };

    function onAbort(): void {
      fail(
        new SignalingConnectError(
          'aborted',
          '[ac2-open-claw] pairing aborted before the signaling socket connected',
        ),
      );
    }

    if (opts.signal?.aborted) {
      onAbort();
      return;
    }

    client.on('connect', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    });

    opts.signal?.addEventListener('abort', onAbort);

    if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(
          new SignalingConnectError(
            'timeout',
            `[ac2-open-claw] signaling socket did not connect within ${opts.timeoutMs}ms`,
          ),
        );
      }, opts.timeoutMs);
    }
  });
}

/**
 * Race an arbitrary pairing-handshake promise against *sustained* signaling
 * socket disconnection (plus an optional abort `signal`) — never against a
 * flat wall-clock deadline. Used to bound the ICE offer/answer/candidate
 * exchange (`SignalClient#peer`), which waits on the human completing
 * pairing (scanning the QR, approving in their wallet) and can legitimately
 * take minutes. A flat timeout there would tear down a perfectly healthy
 * socket just because the human was slow. Instead, this only rejects once
 * `sock` has been continuously disconnected for `deadSocketTimeoutMs` — a
 * real ping-timeout/network failure that socket.io's own reconnection could
 * not recover from in time. Every reconnect (even after several blips)
 * clears the dead-socket timer, so the guard never fires while the socket is
 * healthy, however long the human takes. On failure, invokes `onFailure`
 * (torn down once) and rejects; a later resolution/rejection of `promise`
 * itself is ignored once the guard has already tripped.
 *
 * Disconnect reasons that socket.io will NOT auto-reconnect from (a
 * server-/client-initiated close) fail the current attempt immediately
 * rather than waiting out `deadSocketTimeoutMs` for a reconnect that can
 * never happen — handing off to the caller's re-pair loop (which opens a
 * fresh socket) sooner.
 */
export const SIGNALING_TERMINAL_DISCONNECT_REASONS: ReadonlySet<string> = new Set([
  // socket.io reasons where the client does not attempt reconnection.
  'io server disconnect',
  'io client disconnect',
]);

export function withSignalingHealthGuard<T>(
  promise: Promise<T>,
  sock: {
    on: (event: string, listener: (...args: any[]) => void) => void;
    off?: (event: string, listener: (...args: any[]) => void) => void;
    connected?: boolean;
  },
  opts: { deadSocketTimeoutMs: number; signal?: AbortSignal; onFailure?: () => void },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let deadTimer: ReturnType<typeof setTimeout> | undefined;

    const clearDeadTimer = (): void => {
      if (deadTimer !== undefined) {
        clearTimeout(deadTimer);
        deadTimer = undefined;
      }
    };

    const cleanup = (): void => {
      clearDeadTimer();
      sock.off?.('disconnect', onDisconnect);
      sock.off?.('connect', onReconnect);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const fail = (error: SignalingConnectError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        opts.onFailure?.();
      } catch {
        // Teardown is best-effort; still reject the caller.
      }
      reject(error);
    };

    function onAbort(): void {
      fail(
        new SignalingConnectError(
          'aborted',
          '[ac2-open-claw] pairing aborted before the handshake completed',
        ),
      );
    }

    // socket.io passes the disconnect reason as the first listener arg.
    function onDisconnect(reason?: string): void {
      // A server-/client-initiated close will never auto-reconnect this
      // socket, so there is nothing to wait for — fail now and let the
      // caller's re-pair loop open a fresh socket.
      if (typeof reason === 'string' && SIGNALING_TERMINAL_DISCONNECT_REASONS.has(reason)) {
        fail(
          new SignalingConnectError(
            'timeout',
            `[ac2-open-claw] signaling connection closed during pairing and will not auto-reconnect (${reason})`,
          ),
        );
        return;
      }
      clearDeadTimer();
      deadTimer = setTimeout(() => {
        fail(
          new SignalingConnectError(
            'timeout',
            `[ac2-open-claw] signaling socket stayed disconnected for ${opts.deadSocketTimeoutMs}ms during pairing`,
          ),
        );
      }, opts.deadSocketTimeoutMs);
    }

    function onReconnect(): void {
      clearDeadTimer();
    }

    if (opts.signal?.aborted) {
      onAbort();
      return;
    }

    // Already down when the guard was installed — start counting right away.
    if (sock.connected === false) onDisconnect();

    sock.on('disconnect', onDisconnect);
    sock.on('connect', onReconnect);
    opts.signal?.addEventListener('abort', onAbort);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}

/**
 * Presence detection for a `requestId`, handled outside `SignalClient` on the
 * signaling socket. The Liquid Auth server exposes a dedicated `presence`
 * websocket event: emitting `{ requestId }` returns an ack `{ requestId,
 * deviceCount, online }`, and the same shape is broadcast to the room whenever
 * a peer joins/leaves. This lets a (potentially offline) peer detect whether
 * there is anyone connected for a `requestId` before attempting to reconnect.
 */
export interface PresenceResult {
  requestId: string;
  /** Number of devices currently connected for the `requestId`. */
  deviceCount: number;
  /** Convenience flag: `deviceCount > 0`. */
  online: boolean;
}

/** Minimal socket surface the presence helpers rely on (socket.io-client). */
export interface PresenceSocket {
  emit: (event: string, ...args: any[]) => unknown;
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
}

export const AC2_PRESENCE_EVENT = 'presence';
const AC2_DEFAULT_PRESENCE_TIMEOUT_MS = 10000;

/**
 * Grace window after our OWN signaling socket (re)connects during which a low
 * device count is treated as an untrustworthy recount artifact rather than the
 * peer going offline. When the signaling server restarts, our socket briefly
 * drops and reconnects and the server re-counts the room from scratch — the
 * still-present wallet may not have re-registered yet, so presence momentarily
 * reads a single device. Suppressing presence-driven teardown for this window
 * (while a live data channel already proves the peer is there) avoids tearing
 * down a healthy p2p connection on a mere signaling blip. A genuine departure
 * outlives the window and is acted on as soon as it elapses.
 */
const AC2_SIGNALING_STABLE_GRACE_MS = 5000;

/**
 * Coerce an arbitrary presence payload into a well-formed `PresenceResult`,
 * tolerating a missing/partial ack from an older server. Falls back to the
 * queried `requestId` and derives `online` from `deviceCount` when absent.
 */
export function normalizePresence(requestId: string, data: unknown): PresenceResult {
  const record = (data ?? {}) as Record<string, unknown>;
  const deviceCount =
    typeof record.deviceCount === 'number' && Number.isFinite(record.deviceCount)
      ? record.deviceCount
      : 0;
  const online = typeof record.online === 'boolean' ? record.online : deviceCount > 0;
  const resolvedRequestId =
    typeof record.requestId === 'string' && record.requestId.length > 0
      ? record.requestId
      : requestId;
  return { requestId: resolvedRequestId, deviceCount, online };
}

/**
 * Query how many devices are connected for `requestId` by emitting the
 * `presence` event and awaiting the server ack. Rejects on an empty
 * `requestId` or if no ack arrives within `timeoutMs`.
 */
export function queryPresence(
  socket: PresenceSocket,
  requestId: string,
  opts: { timeoutMs?: number } = {},
): Promise<PresenceResult> {
  const timeoutMs = opts.timeoutMs ?? AC2_DEFAULT_PRESENCE_TIMEOUT_MS;
  return new Promise<PresenceResult>((resolve, reject) => {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      reject(new Error('[ac2-open-claw] presence query requires a non-empty requestId'));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `[ac2-open-claw] timed out waiting for presence ack for ${requestId} (${timeoutMs}ms)`,
        ),
      );
    }, timeoutMs);

    try {
      socket.emit(AC2_PRESENCE_EVENT, { requestId }, (data: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(normalizePresence(requestId, data));
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err as Error);
    }
  });
}

/**
 * Subscribe to server-broadcast `presence` updates. Returns an unsubscribe
 * function. Safe to call against a socket that lacks `on`/`off` (no-op).
 */
export function subscribeToPresence(
  socket: PresenceSocket,
  handler: (presence: PresenceResult) => void,
): () => void {
  const listener = (data: unknown): void => {
    const record = (data ?? {}) as Record<string, unknown>;
    const requestId = typeof record.requestId === 'string' ? record.requestId : '';
    handler(normalizePresence(requestId, data));
  };
  socket.on?.(AC2_PRESENCE_EVENT, listener);
  return () => {
    socket.off?.(AC2_PRESENCE_EVENT, listener);
  };
}

/**
 * Convenience wrapper for the reconnect decision: resolves `true` when at
 * least one device is connected for `requestId`. Swallows query errors and
 * timeouts into `false` so an offline client simply declines to reconnect.
 */
export async function hasPeerPresence(
  socket: PresenceSocket,
  requestId: string,
  opts?: { timeoutMs?: number },
): Promise<boolean> {
  try {
    const presence = await queryPresence(socket, requestId, opts);
    return presence.online;
  } catch {
    return false;
  }
}

/**
 * Decide whether a `presence` broadcast means the linked wallet has gone away
 * and the session should be torn down so the caller can await a fresh link.
 *
 * Mirrors the Liquid Auth demo app's offer-side reset: only AFTER a wallet has
 * actually linked (`peerLinked`) does a drop back to a single device (just this
 * agent) indicate the wallet went offline. Before the first link a single
 * device is the normal "still awaiting the wallet" state and must NOT trigger
 * teardown; an already-closed session never re-triggers.
 *
 * Presence is the FAST signal that the peer left: when the wallet app closes,
 * its socket disconnects and the server broadcasts a drop to a single device
 * almost immediately, whereas the WebRTC data channel can take much longer to
 * notice the peer is gone. So we tear down on a presence drop even once the
 * control data channel is live (`connected`) — this is what lets the agent
 * re-arm and be waiting with a fresh offer-listener BEFORE the wallet reopens,
 * instead of stalling until the heartbeat watchdog fires.
 *
 * The one exception is "the signaling server was lost while we are connected":
 * a presence drop caused by OUR OWN signaling socket dropping/reconnecting is a
 * transient recount artifact, not a real departure, and the live data channel
 * already proves the peer is still there. That case is flagged by
 * `signalingStable === false` (see `AC2_SIGNALING_STABLE_GRACE_MS`), and while
 * it holds a presence drop on a live connection is ignored; a genuinely gone
 * peer is then caught either once signaling restabilizes or by the heartbeat
 * watchdog / control-transport `onClose`. Before the channel is live there is
 * no p2p connection to trust, so a linked peer dropping to a single device is
 * always acted on regardless of signaling stability.
 *
 * Teardown must also stand down while a (re)negotiation is already in flight
 * and not yet connected (`negotiating && !connected`): that armed
 * `SignalClient.peer(...)` — parked awaiting the wallet's re-link/offer — IS
 * the "awaiting the wallet" state a teardown would otherwise re-create, and
 * tearing it down is actively destructive. `teardownPeer` nulls the
 * SignalClient's `peerClient` underneath the pending `peer()`, so when the
 * wallet came back and the handshake resumed it crashed with
 * `TypeError: Cannot set properties of undefined (setting 'onicecandidate')`
 * (torn down while parked in `link()`) or `Cannot read properties of
 * undefined (reading 'setRemoteDescription')` (torn down while awaiting the
 * offer), failing the wallet's first re-link attempt. Once `connected` the
 * negotiation has resolved, so the fast presence path above applies as usual.
 */
export function shouldTeardownOnPresence(
  presence: PresenceResult,
  state: {
    peerLinked: boolean;
    closed: boolean;
    connected: boolean;
    signalingStable: boolean;
    negotiating: boolean;
  },
): boolean {
  if (!state.peerLinked || state.closed) return false;
  if (presence.deviceCount > 1) return false;
  // A negotiation is already armed and waiting for the wallet — there is
  // nothing stale to tear down, and doing so would null the SignalClient's
  // `peerClient` under the in-flight `peer()` (crashing the handshake the
  // moment the wallet re-links). Leave the armed negotiation in place.
  if (state.negotiating && !state.connected) return false;
  // The peer appears offline. On a LIVE connection only trust the drop when our
  // own signaling link is stable — otherwise it is a signaling-server blip, not
  // a real departure.
  if (state.connected && !state.signalingStable) return false;
  return true;
}

/**
 * Decide whether a heartbeat (data-channel liveness) timeout should tear the
 * control channel down.
 *
 * The heartbeat is the SLOW signal — a WebRTC data channel can take a long time
 * to notice a peer is gone — and mobile controllers legitimately suspend their
 * `ac2-heartbeat` channel while backgrounded WITHOUT having actually left. So
 * the heartbeat is only the authority for a departed peer when we have NO
 * connection to the signaling server (`signalingConnected === false`): with the
 * signaling socket up, server-side presence is the faster, trusted departure
 * signal (see `shouldTeardownOnPresence`) and a heartbeat timeout must be
 * ignored — otherwise a still-present, merely-quiet peer is dropped, producing
 * spurious "peer went offline" churn on a link the server still reports as
 * present.
 */
export function shouldCloseOnHeartbeatTimeout(state: {
  staleForTooLong: boolean;
  signalingConnected: boolean;
}): boolean {
  return state.staleForTooLong && !state.signalingConnected;
}

/**
 * Parse a raw `set-cookie` response header into a `Cookie` request-header
 * value (`name=value; name2=value2`). Accepts either an array of cookie
 * strings (Node's typical shape) or a single comma-joined string, splitting
 * only at genuine cookie boundaries so `Expires=...,` dates are not mangled.
 */
export function cookiePairsFromSetCookie(
  setCookie: string | string[] | null | undefined,
): string | undefined {
  if (!setCookie) return undefined;
  const entries = Array.isArray(setCookie)
    ? setCookie
    : String(setCookie).split(/,(?=[^;,]+?=)/);
  const pairs = entries
    .map((entry) => entry.split(';')[0]?.trim())
    .filter((pair): pair is string => Boolean(pair && pair.includes('=')));
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/**
 * Persist the signaling server's session cookie so the agent reuses the SAME
 * server session across restarts (like a browser would). Reusing one session
 * avoids leaving stale sessions bound to this `requestId` on the server, which
 * would otherwise shadow the live wallet session during the reconnect
 * rendezvous and leave the agent "waiting on a link".
 *
 * The cookie is captured from the polling handshake response and handed to
 * `onCookie` (which persists it however the caller sees fit — see
 * `LiquidAuthChannelProviderOptions.sessionCookie`), and mirrored into the
 * manager's `extraHeaders` so in-process reconnects resend it too.
 * Best-effort throughout: cookie handling is a reconnect optimization and
 * must never break pairing.
 */
function attachSessionCookiePersistence(socket: any, onCookie: (cookie: string) => void): void {
  const capture = (): void => {
    try {
      const transport = socket?.io?.engine?.transport;
      const xhr = transport?.pollXhr?.xhr;
      if (!xhr || typeof xhr.getResponseHeader !== 'function') return;
      const cookie = cookiePairsFromSetCookie(xhr.getResponseHeader('set-cookie'));
      if (!cookie) return;
      if (socket.io) {
        socket.io.opts = socket.io.opts ?? {};
        socket.io.opts.extraHeaders = { ...(socket.io.opts.extraHeaders ?? {}), cookie };
      }
      onCookie(cookie);
    } catch {
      // best-effort
    }
  };
  const bind = (): void => {
    try {
      const transport = socket?.io?.engine?.transport;
      if (transport && typeof transport.on === 'function') {
        transport.on('pollComplete', capture);
      }
    } catch {
      // best-effort
    }
  };
  // A reconnect spins up a fresh engine/transport, so (re)bind on every open.
  try {
    socket?.io?.on?.('open', bind);
  } catch {
    // best-effort
  }
  bind();
}

/**
 * Injectable store for the signaling server's session cookie, keyed by
 * pairing `requestId`. The SDK has no notion of "application state" — the
 * caller (e.g. `@algorandfoundation/ac2-cli`) adapts its own on-disk state
 * module to this shape and passes it in via
 * `LiquidAuthChannelProviderOptions.sessionCookie`. Mirrors the call
 * signatures of a typical persistence layer: a synchronous, best-effort
 * `get`/`set` pair.
 */
export interface Ac2SessionCookieStore {
  /** Look up a previously captured session cookie for `key`, if any. */
  get(key: string): string | null | undefined;
  /** Persist the session cookie for `key`. */
  set(key: string, cookie: string): void;
}

/** Severity of a diagnostic emitted by {@link LiquidAuthChannelProvider}. */
export type Ac2ProviderLogLevel = 'info' | 'warn' | 'error';

/**
 * Sink for the provider's own diagnostics (signaling connect/disconnect,
 * presence, heartbeat). Injectable so a host process can fold them into ITS
 * log stream instead of raw `console` writes: the ac2 daemon, for instance,
 * stamps every line it logs with an ISO timestamp, and signaling lines that
 * bypassed that wrapper could not be correlated against the signaling
 * server's own timestamped log — which is exactly what made "is it the daemon
 * or the service?" unanswerable from the captured logs.
 */
export type Ac2ProviderLogger = (level: Ac2ProviderLogLevel, line: string) => void;

/**
 * Fallback logger used when no {@link Ac2ProviderLogger} is injected. Writes
 * to `console` but ALWAYS prefixes an ISO timestamp, so even un-hosted output
 * can be lined up against a server log.
 */
const defaultProviderLogger: Ac2ProviderLogger = (level, line) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(stamped);
  // eslint-disable-next-line no-console
  else if (level === 'warn') console.warn(stamped);
  // eslint-disable-next-line no-console
  else console.log(stamped);
};

export interface LiquidAuthChannelProviderOptions {
  /** Liquid Auth signaling server origin. */
  origin?: string;
  /** Pre-supplied requestId (otherwise `SignalClient.generateRequestId()`). */
  requestId?: string;
  /** Request the optional `ac2-stream` channel (default `true`). */
  includeStreamChannel?: boolean;
  /** Milliseconds without inbound heartbeat traffic before closing. */
  heartbeatTimeoutMs?: number;
  /**
   * Optional presence listener. When provided, server-broadcast `presence`
   * updates for the `requestId` are forwarded here so the caller can track how
   * many devices are connected (and decide whether reconnecting is worthwhile).
   * Handled outside `SignalClient`, directly on the signaling socket.
   */
  onPresence?: (presence: PresenceResult) => void;
  /**
   * Optional external store for the signaling session cookie, keyed by the
   * pairing `requestId`. When provided, the cookie the signaling server sets
   * on the polling handshake is persisted through it (and replayed on the
   * next `startPairing()`), letting the caller reuse the same server session
   * across process restarts. When omitted, the provider keeps the cookie in
   * memory for this instance's lifetime only — it still works, it just does
   * not survive a restart.
   */
  sessionCookie?: Ac2SessionCookieStore;
  /**
   * Sink for this provider's diagnostics. Defaults to a `console` writer that
   * prefixes an ISO timestamp. Every line is additionally tagged with the
   * pairing `requestId`, so concurrent pairings stay distinguishable.
   */
  logger?: Ac2ProviderLogger;
}

/**
 * `Ac2PairingHandle` extended with this provider's persistent-signaling
 * lifecycle hooks. Kept local (rather than relying on the optional members on
 * the SDK's `Ac2PairingHandle`) so the reference package compiles against the
 * currently-published SDK regardless of whether those optional members are
 * present in the consumed type. Callers can consult `isSignalingAlive()` after
 * a peer drop to re-arm `connect()` on the SAME live socket, and `dispose()` to
 * fully tear the socket down when abandoning the handle.
 */
export interface LiquidAuthPairingHandle extends Ac2PairingHandle {
  /** Whether the persistent signaling socket is still connected. */
  isSignalingAlive(): boolean;
  /** Fully tear down the persistent signaling socket + peer. Idempotent. */
  dispose(): Promise<void>;
}

export class LiquidAuthChannelProvider implements Ac2ChannelProvider {
  /**
   * In-memory fallback for the signaling session cookie, used only when
   * `defaults.sessionCookie` is not injected (see
   * `LiquidAuthChannelProviderOptions.sessionCookie`).
   */
  private inMemorySessionCookie: string | undefined;

  constructor(private readonly defaults: LiquidAuthChannelProviderOptions = {}) { }

  private readSessionCookie(requestId: string): string | undefined {
    if (this.defaults.sessionCookie) {
      return this.defaults.sessionCookie.get(requestId) ?? undefined;
    }
    return this.inMemorySessionCookie;
  }

  private writeSessionCookie(requestId: string, cookie: string): void {
    if (this.defaults.sessionCookie) {
      this.defaults.sessionCookie.set(requestId, cookie);
    } else {
      this.inMemorySessionCookie = cookie;
    }
  }

  async startPairing(opts: Ac2StartPairingOptions = {}): Promise<LiquidAuthPairingHandle> {
    await ensureWebRtcPolyfill();
    const { SignalClient } = await importSignalClient();
    const { io: createSocketIoClient } = await importSocketIoClient();

    const origin = this.defaults.origin ?? 'https://debug.liquidauth.com';
    const requestId = this.defaults.requestId ?? SignalClient.generateRequestId();
    const includeStream = this.defaults.includeStreamChannel ?? true;
    // Every diagnostic below goes through here rather than `console` directly,
    // so the host's log formatting (timestamps) applies and each line names the
    // pairing it belongs to.
    const sink = this.defaults.logger ?? defaultProviderLogger;
    const log = (level: Ac2ProviderLogLevel, message: string): void => {
      sink(level, `[ac2] [requestId=${requestId}] ${message}`);
    };
    const heartbeatTimeoutMs =
      this.defaults.heartbeatTimeoutMs ??
      resolveHeartbeatTimeoutMs(process.env['AC2_HEARTBEAT_TIMEOUT_MS']);

    // Build the signaling socket from the Node-native `socket.io-client` and
    // pass it to `SignalClient` via its `{ socket }` option. Replay any
    // previously captured server session cookie so the agent reuses the same
    // session across restarts (see `attachSessionCookiePersistence`), which is
    // what lets the reconnect rendezvous find the live wallet session instead
    // of a stale duplicate.
    const persistedCookie = this.readSessionCookie(requestId);
    const socket = createSocketIoClient(origin, {
      autoConnect: true,
      // Polling-first (the socket.io default), then upgrade to websocket. This
      // MUST NOT be websocket-first: the Liquid Auth signaling server creates
      // and persists the Express session — and sets the session cookie — during
      // the initial HTTP long-polling handshake. That server session is what
      // the gateway's `link` handler looks up (`findSession(sessionID)`) before
      // joining the socket into the `requestId` presence room; without it the
      // agent emits `link` but is NEVER counted as a present device, so the
      // wallet (which authenticates and so does have a session) sees only
      // itself (`deviceCount === 1`) and tears the pairing down as "peer went
      // offline". Starting on websocket skips that handshake entirely, which
      // also defeats `attachSessionCookiePersistence` below (it reads the
      // polling handshake's `set-cookie`). The connection still upgrades to
      // websocket immediately after the handshake, so steady-state transport is
      // unchanged — only the one-time handshake (and reconnect handshakes) go
      // over polling, which is exactly what establishes presence.
      transports: ['polling', 'websocket'],
      ...(persistedCookie ? { extraHeaders: { cookie: persistedCookie } } : {}),
    });
    attachSessionCookiePersistence(socket, (cookie) => this.writeSessionCookie(requestId, cookie));

    const client = new SignalClient(origin, { socket: socket as any });

    // Session lifecycle state, declared up-front so the presence subscription
    // below can drive teardown once a wallet has linked. `peerLinked` is sticky
    // across reconnects (the wallet stays authenticated on the same requestId);
    // `closed`/`connected` are per-negotiation and reset at the start of each
    // `connect()` so the SAME signaling socket can be reused for the next peer
    // session (see `teardownPeer`).
    let peerLinked = false;
    let closed = false;
    // Set once the control DataChannel is actually live. Departure authority is
    // split by whether our OWN signaling link is up: while it is, server-side
    // presence is the fast, trusted "peer left" signal (a drop to a single
    // device tears down — see `shouldTeardownOnPresence` / `signalingStable`
    // below), and the slower data-channel heartbeat must NOT tear the link down
    // (a backgrounded controller can suspend its heartbeat without leaving).
    // Only when our signaling link is lost do the heartbeat watchdog /
    // control-transport `onClose` become authoritative, since there is then no
    // presence to trust.
    let connected = false;
    // Guards against overlapping `connect()` calls re-arming the answer flow on
    // the same socket concurrently (`SignalClient.peer` cannot run twice at
    // once).
    let negotiating = false;

    // Health of OUR OWN signaling link. A presence drop to a single device only
    // means the peer really left if the drop was NOT caused by our signaling
    // socket itself dropping/reconnecting. We start optimistic (the socket is
    // connecting) and mark it unstable on a `disconnect`, restoring stability
    // only after a grace window past the next `connect` so the server has time
    // to re-count the still-present wallet in the room. This is what makes
    // "close on peer offline, but NOT on a signaling-server loss while we are
    // connected" a precise, non-racy decision.
    let signalingStable = true;
    let signalingGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const markSignalingUnstable = (): void => {
      signalingStable = false;
      if (signalingGraceTimer) {
        clearTimeout(signalingGraceTimer);
        signalingGraceTimer = undefined;
      }
    };
    const markSignalingStableSoon = (): void => {
      if (signalingGraceTimer) clearTimeout(signalingGraceTimer);
      signalingGraceTimer = setTimeout(() => {
        signalingStable = true;
        signalingGraceTimer = undefined;
      }, AC2_SIGNALING_STABLE_GRACE_MS);
      // Don't keep the event loop alive just for the grace timer.
      (signalingGraceTimer as { unref?: () => void }).unref?.();
    };
    socket.on?.('disconnect', markSignalingUnstable);
    socket.on?.('connect', markSignalingStableSoon);
    // The socket auto-connects; if it is already up, arm the initial grace.
    if ((socket as { connected?: boolean }).connected) markSignalingStableSoon();
    else markSignalingUnstable();

    // Wake-aware reconnect kick. When the OS suspends, the process freezes and
    // Node timers (monotonic clock) pause with it — so on resume socket.io may
    // idle in its exponential reconnect backoff although the network is back.
    // A wall-clock jump between ticks is the tell-tale of a suspend; when the
    // socket is down after one, kick a reconnect right away so the link is
    // usually restored before the dead-socket guard fires.
    let lastWakeCheckAt = Date.now();
    const wakeCheckTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastWakeCheckAt;
      lastWakeCheckAt = now;
      if (elapsed < AC2_WAKE_JUMP_THRESHOLD_MS) return;
      if ((socket as { connected?: boolean }).connected) return;
      log(
        'info',
        `Detected system wake (clock jumped ${elapsed}ms) — reconnecting signaling socket now.`,
      );
      try {
        (socket as { connect?: () => void }).connect?.();
      } catch {
        // Best-effort nudge; socket.io's own reconnection keeps retrying.
      }
    }, AC2_WAKE_CHECK_INTERVAL_MS);
    // Don't keep the event loop alive just for the wake detector.
    (wakeCheckTimer as { unref?: () => void }).unref?.();

    // Per-negotiation peer state. Hoisted to the pairing scope (rather than
    // living inside `connect()`) so `teardownPeer` can tear down ONLY the p2p
    // peer between attempts while the signaling socket stays connected.
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let controlChannel: any;
    let streamChannel: any;
    let heartbeatChannel: any;
    let onDataChannel: ((channel: any) => void) | undefined;

    // Forward-declared so the presence subscription and the reactive re-offer
    // listener (both bound once, below) can trigger teardown before `connect()`
    // assigns the real implementation. Reassigned inside `connect()`.
    let close: () => Promise<void> = async () => {
      /* assigned in connect() */
    };

    /**
     * Tear down ONLY the p2p peer + its data channels and detach the
     * per-negotiation signaling listeners, KEEPING the signaling socket (and
     * its presence subscription) connected. This mirrors the wallet's
     * `clearTransport`: closing the leaked `RTCPeerConnection` is required so
     * the peer no longer treats the old session as active, and detaching the
     * SDK's per-negotiation listeners stops them accumulating (double-applied
     * candidates / data-channel events) when the same socket is reused for the
     * next `client.peer(...)`. Idempotent and safe to call before the first
     * negotiation.
     */
    const teardownPeer = (): void => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      closeRtcDataChannel(heartbeatChannel);
      closeRtcDataChannel(streamChannel);
      closeRtcDataChannel(controlChannel);
      heartbeatChannel = undefined;
      streamChannel = undefined;
      controlChannel = undefined;
      try {
        (client as any).peerClient?.close?.();
      } catch {
        // Already closed; ignore.
      }
      // Allow a fresh `client.peer(...)` on the reused SignalClient (it refuses
      // to run while a peer/requestId is still in progress).
      (client as any).peerClient = undefined;
      // Detach the listeners the SDK's `peer()` adds per negotiation so reusing
      // this socket doesn't accumulate duplicate handlers. The persistent
      // presence + signaling-stability listeners (bound once below) are left
      // attached: they must survive to detect the wallet leaving/returning on
      // the live socket.
      try {
        if (onDataChannel) client.off('data-channel', onDataChannel);
        else client.off('data-channel');
      } catch {
        // Best-effort.
      }
      onDataChannel = undefined;
      const s = ((client as any).socket ?? socket) as {
        off?: (event: string) => void;
      };
      try {
        s?.off?.('offer-candidate');
        s?.off?.('answer-candidate');
        s?.off?.('answer-description');
      } catch {
        // Best-effort.
      }
    };

    /**
     * Drop the signaling socket AND its underlying engine.
     *
     * `socket.close()` alone is not enough on a socket whose transport has
     * already broken (`transport close`): socket.io marks the client closed but
     * the disconnect packet never reaches the wire, so the SERVER keeps the
     * session alive until its own heartbeat expires (pingInterval + pingTimeout
     * = 45 s by default). A reconnect loop abandoning sockets that way leaves a
     * pile of orphaned sessions squatting in the requestId's presence room,
     * which corrupts `deviceCount` and triggers spurious "peer went offline"
     * teardowns. Closing the engine too forces the transport down immediately.
     */
    const forceSocketDown = (): void => {
      try {
        (socket as { close?: () => void }).close?.();
      } catch {
        // Already closed; ignore.
      }
      try {
        (socket as { io?: { engine?: { close?: () => void } } }).io?.engine?.close?.();
      } catch {
        // Engine already gone; ignore.
      }
    };

    /**
     * Fully tear down the persistent signaling socket (and peer). Used only
     * when the pairing handle is abandoned or a hard signaling failure means
     * the socket can no longer be reused — NOT on an ordinary peer drop, which
     * keeps the socket alive for a fast in-place re-link.
     */
    const fullTeardown = (): void => {
      teardownPeer();
      clearInterval(wakeCheckTimer);
      if (signalingGraceTimer) {
        clearTimeout(signalingGraceTimer);
        signalingGraceTimer = undefined;
      }
      signalingStable = false;
      try {
        socket.off?.('disconnect', markSignalingUnstable);
        socket.off?.('connect', markSignalingStableSoon);
      } catch {
        // Best-effort.
      }
      try {
        client.close(true);
      } catch {
        // Already closed; ignore.
      }
      forceSocketDown();
    };

    // Presence is handled outside SignalClient, directly on the socket. Track
    // how many devices are connected for this requestId — used to detect
    // whether a peer is available before/after pairing (the "should an offline
    // client even attempt to reconnect?" decision).
    const onPresence = this.defaults.onPresence;
    subscribeToPresence(socket as unknown as PresenceSocket, (presence) => {
      if (presence.requestId && presence.requestId !== requestId) return;
      log(
        'info',
        `presence for ${presence.requestId}: ${presence.deviceCount} device(s), online=${presence.online}`,
      );
      onPresence?.(presence);
      // Presence-driven teardown. A drop back to a single device (just this
      // agent) after the wallet has linked means the peer went offline — this
      // is the FAST path that closes the session immediately when the phone is
      // closed, instead of waiting out the heartbeat. Crucially, it now fires
      // even while the control data channel is `connected`, so the agent tears
      // the stale peer down and re-arms `connect()` — leaving a fresh offer
      // listener armed on the SAME socket — BEFORE the wallet reopens. When the
      // phone comes back and re-sends its offer, the agent answers it in place:
      // no QR rescan, no manual Reconnect, no timeout.
      //
      // Two exceptions, both handled inside `shouldTeardownOnPresence`:
      //  - a presence drop caused by OUR OWN signaling socket dropping/
      //    reconnecting (a signaling-server loss while we stay connected) is a
      //    transient recount artifact, not a departure (`signalingStable`);
      //  - a drop while a (re)negotiation is already armed and waiting
      //    (`negotiating && !connected`) must NOT tear down: the pending
      //    `SignalClient.peer(...)` is exactly what answers the returning
      //    wallet, and nulling its `peerClient` mid-handshake crashed the
      //    re-link with `onicecandidate`/`setRemoteDescription`-on-undefined
      //    TypeErrors.
      if (
        shouldTeardownOnPresence(presence, {
          peerLinked,
          closed,
          connected,
          signalingStable,
          negotiating,
        })
      ) {
        log(
          'warn',
          `peer went offline (presence: ${presence.deviceCount} device(s)) — tearing down to await re-link.`,
        );
        void close();
      }
    });

    // Capture the wallet account from the Liquid Auth `link` response. The
    // `link-message` also marks the wallet as linked, arming the presence-driven
    // teardown above (a later drop to a single device means the wallet left).
    let linkedWallet: string | undefined;
    client.on('link-message', (data: { wallet?: string; credId?: string } | undefined) => {
      peerLinked = true;
      if (data && typeof data.wallet === 'string' && data.wallet.length > 0) {
        linkedWallet = data.wallet;
      }
    });

    // Ceiling for the initial socket connect only (see below) — that phase
    // has no human action to wait on, so a flat deadline is appropriate.
    const pairingTimeoutMs = opts.timeoutMs ?? AC2_DEFAULT_PAIRING_TIMEOUT_MS;

    // Block resolving until the signaling socket is up (the caller renders
    // the QR only after `startPairing` resolves). Bounded by `timeoutMs` and
    // the caller's abort signal so an unreachable signaling server rejects
    // instead of hanging the re-pairing loop forever — and the failing socket
    // is torn down so it stops emitting reconnect/ping-timeout noise.
    const waitForConnect = awaitSignalConnect(client, {
      timeoutMs: pairingTimeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      onFailure: () => {
        try {
          client.close(true);
        } catch {
          // Already closed; ignore.
        }
        forceSocketDown();
      },
    });
    // Bind low-level error/disconnect diagnostics once the socket is built.
    void (async () => {
      try {
        const internal = client as unknown as { _socketPromise?: Promise<void>; socket?: any };
        if (internal._socketPromise) await internal._socketPromise;
        const sock = internal.socket;
        if (sock && typeof sock.on === 'function') {
          sock.on('connect_error', (err: any) => {
            const description =
              err?.description !== undefined ? ` description=${String(err.description)}` : '';
            const ctxStatus =
              err?.context?.status !== undefined ? ` status=${String(err.context.status)}` : '';
            log(
              'error',
              `Signaling socket connect_error: ${err?.message ?? err}${description}${ctxStatus}`,
            );
          });
          sock.on('disconnect', (reason: unknown, details: unknown) => {
            const extra = details ? ` details=${JSON.stringify(details)}` : '';
            log('error', `Signaling socket disconnect reason: ${String(reason)}${extra}`);
          });
          const engine = sock.io?.engine;
          if (engine && typeof engine.on === 'function') {
            engine.on('close', (reason: unknown) =>
              log('error', `Signaling engine closed: ${String(reason)}`),
            );
          }
          if (sock.io && typeof sock.io.on === 'function') {
            sock.io.on('error', (err: Error) =>
              log('error', `Signaling manager error: ${err?.message ?? err}`),
            );
          }
        }
      } catch (err) {
        log('error', `Failed to initialize signaling socket: ${(err as Error).message}`);
      }
    })();

    const qrPayload: string = client.deepLink(requestId);

    const pairing: Ac2PairingInfo = {
      qrPayload,
      metadata: { origin, requestId },
    };

    const connect = async (): Promise<Ac2PairedChannel> => {
      // Serialize (re)negotiations: the SDK's `SignalClient.peer` cannot run
      // twice concurrently on one socket.
      if (negotiating) {
        throw new Error('[ac2-open-claw] connect() called while a negotiation is already in flight');
      }
      negotiating = true;
      try {
        // Reuse the SAME signaling socket for every attempt: tear down only the
        // previous p2p peer (if any) and reset the per-negotiation flags so a
        // returning wallet is answered in place, without re-authenticating or
        // dropping out of the requestId room. No-op on the first call.
        teardownPeer();
        closed = false;
        connected = false;

        // `peer(...)` resolves with the primary channel; the rest arrive via
        // `'data-channel'`. Track the collector so `teardownPeer` can detach
        // exactly this listener before the next attempt re-registers its own.
        onDataChannel = (channel: any): void => {
          if (channel.label === AC2_CONTROL_LABEL) controlChannel = channel;
          else if (channel.label === AC2_STREAM_LABEL) streamChannel = channel;
          else if (channel.label === AC2_HEARTBEAT_LABEL) heartbeatChannel = channel;
        };
        client.on('data-channel', onDataChannel);

        type DataChannelInit = { ordered?: boolean };
        const dataChannels: Record<string, DataChannelInit> = {
          [AC2_CONTROL_LABEL]: { ordered: true },
          ...(includeStream ? { [AC2_STREAM_LABEL]: { ordered: true } } : {}),
          [AC2_HEARTBEAT_LABEL]: { ordered: true },
        };
        // Bounded by sustained signaling-socket disconnection, not a flat
        // deadline: `peer(...)`'s offer/answer/candidate exchange waits on the
        // human scanning the QR and approving in their wallet, which can take
        // minutes. Only a real, sustained network/ping-timeout failure (the
        // socket staying down longer than the reconnect grace period) should
        // tear this down — not the human simply taking their time. A genuine
        // failure here means the socket itself is unusable, so fully tear it
        // down (the caller then builds a fresh pairing handle).
        const primary: any = await withSignalingHealthGuard(
          client.peer(requestId, 'offer', AC2_ICE_CONFIG, { dataChannels }),
          socket,
          {
            deadSocketTimeoutMs: AC2_DEFAULT_SIGNAL_DEAD_TIMEOUT_MS,
            ...(opts.signal ? { signal: opts.signal } : {}),
            onFailure: () => {
              fullTeardown();
            },
          },
        );
        controlChannel = controlChannel ?? primary;

        if (controlChannel.label !== AC2_CONTROL_LABEL) {
          throw new Error(
            `[ac2-open-claw] Expected control channel labeled "${AC2_CONTROL_LABEL}", got "${controlChannel.label}". ` +
              `The Controller app must use the latest liquid-auth-js with ac2-v1 support.`,
          );
        }

        // Brief grace period so the app attaches handlers before resolve.
        await new Promise((resolve) => setTimeout(resolve, 500));

        const { transport, emitClose } = closeAwareTransport(
          rtcDataChannelTransport(controlChannel),
        );

        if (!transport.isOpen) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('Timeout waiting for DataChannel to open')),
              10000,
            );
            transport.onOpen(() => {
              clearTimeout(timeout);
              resolve();
            });
            transport.onError((err) => {
              clearTimeout(timeout);
              reject(err);
            });
          });
        }

        // The control data channel is now live. Departure authority now follows
        // a single rule (see also the presence subscription and
        // `shouldTeardownOnPresence`): while our signaling socket is connected,
        // server-side PRESENCE is the fast, trusted signal that the peer left —
        // the (slower, mobile-suspendable) data-channel heartbeat must NOT tear
        // the connection down. The heartbeat only becomes the authority when we
        // have NO connection to the signaling server (no presence to trust).
        connected = true;

        // Bidirectional keep-alive: each side pings on its own timer AND replies
        // PONG to the peer's pings. `lastInboundAt` is updated on any inbound
        // frame (PING or PONG); the interval below only declares the peer dead
        // (and triggers `close()` so the control transport's `onClose`
        // propagates upstream) when the heartbeat has gone silent AND our
        // signaling socket is down — otherwise presence owns that decision.
        //
        // The heartbeat channel is optional and mobile controllers can suspend
        // it while backgrounded. Only enforce the timeout when the heartbeat
        // channel is present and open; presence / the WebRTC / control close
        // handlers remain authoritative for peers that really go away.
        let lastInboundAt = Date.now();

        if (heartbeatChannel) {
          heartbeatChannel.onmessage = (ev: { data: unknown }) => {
            lastInboundAt = Date.now();
            if (ev?.data === AC2_HEARTBEAT_PING && heartbeatChannel.readyState === 'open') {
              try {
                heartbeatChannel.send(AC2_HEARTBEAT_PONG);
              } catch {
                // Channel closing between check and send; ignore.
              }
            }
          };
        }

        heartbeat = setInterval(() => {
          if (!heartbeatChannel || heartbeatChannel.readyState !== 'open') return;

          const staleForTooLong = Date.now() - lastInboundAt > heartbeatTimeoutMs;
          // While our signaling socket is alive, presence is the authority for a
          // departed peer (it is faster and reflects the room membership the
          // server tracks). A mobile controller can legitimately suspend its
          // heartbeat channel while backgrounded without having actually left,
          // so a heartbeat timeout MUST NOT tear the channel down while the
          // socket is up — that produced spurious drops of a link the server
          // still reported as present. Only when we have no connection to the
          // signaling server (no presence to trust) does the heartbeat become
          // authoritative again (see `shouldCloseOnHeartbeatTimeout`).
          const signalingConnected = (socket as { connected?: boolean }).connected === true;
          if (shouldCloseOnHeartbeatTimeout({ staleForTooLong, signalingConnected })) {
            log(
              'warn',
              `Heartbeat timeout (${heartbeatTimeoutMs}ms with no inbound) and signaling is down — closing channel.`,
            );
            void close();
            return;
          }
          // Otherwise keep pinging: this both keeps the peer warm and lets a
          // returning heartbeat clear `lastInboundAt` once traffic resumes.
          try {
            if (heartbeatChannel && heartbeatChannel.readyState === 'open') {
              heartbeatChannel.send(AC2_HEARTBEAT_PING);
            }
          } catch {
            // Channel closed between checks; ignore.
          }
        }, AC2_HEARTBEAT_MS);

        // Peer-only close: tear down the p2p peer + channels and notify the
        // consumer (via `emitClose`), but KEEP the signaling socket connected so
        // the caller can immediately re-arm `connect()` and answer a returning
        // wallet in place. A truly dead socket is handled separately by
        // `fullTeardown` (health-guard `onFailure`) / `dispose`.
        close = async (): Promise<void> => {
          if (closed) return;
          closed = true;
          connected = false;
          teardownPeer();
          emitClose();
        };

        const channel: Ac2PairedChannel = {
          transport,
          ...(streamChannel !== undefined ? { streamChannel } : {}),
          // Heartbeat is intentionally out-of-band: the `ac2-heartbeat`
          // DataChannel is still negotiated and pinged inside this provider
          // (see the `setInterval` above) for liveness, but it is NOT exposed
          // on the returned `Ac2PairedChannel`. Consumers that need to detect
          // a dead peer should rely on the control transport's `onClose` /
          // signaling-engine close events rather than a dedicated channel —
          // and the SDK's public `Ac2PairedChannel` shape stays in sync with
          // `@algorandfoundation/ac2-sdk` (no `heartbeatChannel?` field).
          // Bind the real connected wallet (normalized to canonical `did:key:z…`).
          ...(linkedWallet !== undefined
            ? {
                peer: {
                  did: normalizeDidKey(`did:key:${linkedWallet}`),
                  wallet: linkedWallet,
                },
              }
            : {}),
          close,
        };
        return channel;
      } finally {
        negotiating = false;
      }
    };

    // Whether the persistent signaling socket is still connected. The caller
    // consults this after a peer drop to decide between re-arming `connect()`
    // on this SAME socket (fast in-place re-link, no presence churn) versus
    // building a fresh pairing handle.
    const isSignalingAlive = (): boolean => {
      try {
        return (socket as { connected?: boolean }).connected === true;
      } catch {
        return false;
      }
    };

    // Fully tear down the persistent signaling socket + peer. Idempotent; used
    // when the caller abandons this handle (e.g. before replacing it).
    const dispose = async (): Promise<void> => {
      closed = true;
      connected = false;
      fullTeardown();
    };

    await waitForConnect;

    return { pairing, connect, isSignalingAlive, dispose };
  }
}
