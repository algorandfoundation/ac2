/**
 * Control-socket protocol shared by the AC2 daemon (`ac2 service …`) and its
 * local clients (the `ac2` CLI itself plus agent hosts such as OpenClaw or
 * Hermes).
 *
 * Transport: newline-delimited JSON (NDJSON) over a Unix domain socket
 * (named pipe on Windows). Each line is a single JSON document:
 *
 * - Requests:      `{ "id": 1, "method": "daemon.status", "params": { … } }`
 * - Responses:     `{ "id": 1, "result": { … } }` or
 *                  `{ "id": 1, "error": { "code": "…", "message": "…" } }`
 * - Notifications: `{ "event": "connection.connected", "data": { … } }`
 *   (server → client only, no `id`; delivered to subscribed clients).
 *
 * The daemon owns the wallet connection lifecycle (Liquid Auth pairing,
 * WebRTC channel, identity persistence, keystore). Agents never talk to the
 * wallet directly — they register over this socket and the daemon brokers
 * inbound/outbound traffic to the agent the wallet controller targets
 * (default: {@link DEFAULT_TARGET_AGENT}).
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Identifier the daemon routes wallet traffic to when none is specified. */
export const DEFAULT_TARGET_AGENT = 'openclaw';

/** Protocol revision negotiated in `agent.hello` / `daemon.status`. */
export const CONTROL_PROTOCOL_VERSION = 1;

/**
 * Root directory for daemon runtime state (socket, pidfile, logfile).
 * Override with `AC2_HOME`.
 */
export function resolveAc2Home(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AC2_HOME?.trim();
  return override && override.length > 0 ? override : join(homedir(), '.ac2');
}

/**
 * Control socket path. Override with `AC2_DAEMON_SOCKET`. On Windows a named
 * pipe is used because Unix domain socket paths are not portable there.
 *
 * A named pipe has no directory to live in, so the *profile* has to be encoded
 * in its name: with a custom `AC2_HOME` the pipe is suffixed with a digest of
 * that home, mirroring the per-home socket file on POSIX (otherwise two AC2
 * profiles on one Windows box would fight over a single pipe). The default home
 * keeps the historical, unsuffixed name.
 */
export function resolveControlSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.AC2_DAEMON_SOCKET?.trim();
  if (override && override.length > 0) return override;
  if (platform === 'win32') {
    const home = env.AC2_HOME?.trim();
    if (!home) return '\\\\.\\pipe\\ac2-daemon';
    const digest = createHash('sha256').update(home).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\ac2-daemon-${digest}`;
  }
  return join(resolveAc2Home(env), 'ac2d.sock');
}

/** Pidfile written by the detached daemon so the CLI can manage it. */
export function resolvePidFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAc2Home(env), 'ac2d.pid');
}

/** Append-only daemon log consumed by `ac2 service attach` / `logs`. */
export function resolveLogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAc2Home(env), 'ac2d.log');
}

/** High-level wallet-connection state advertised by the daemon. */
export type ConnectionState =
  | 'idle' // daemon up, no pairing in progress
  | 'pairing' // QR issued, waiting for the wallet to scan / handshake
  | 'connected' // data channel open with the wallet
  | 'reconnecting'; // channel dropped, daemon is re-establishing

/** Requests → results. Keep in sync with {@link CONTROL_METHODS}. */
export interface ControlMethods {
  /** Daemon liveness, connection snapshot, and registered agents. */
  'daemon.status': {
    params: Record<string, never>;
    result: DaemonStatus;
  };
  /** Graceful shutdown (responds before exiting). */
  'daemon.stop': {
    params: Record<string, never>;
    result: { stopping: true };
  };
  /**
   * Start (or return the already-active) pairing cycle. The QR payload is
   * rendered by the CLI; `connection.*` events follow on subscribed clients.
   */
  'pair.start': {
    params: { timeoutMs?: number };
    result: { requestId: string; qrPayload: string; origin: string };
  };
  /** Abort the active pairing cycle (keeps the daemon running). */
  'pair.cancel': {
    params: Record<string, never>;
    result: { cancelled: boolean };
  };
  /** Persisted wallet connections known to the daemon. */
  'connections.list': {
    params: Record<string, never>;
    result: { connections: ConnectionSummary[] };
  };
  /** Forget a persisted connection (and its agent identities). */
  'connections.forget': {
    params: { requestId?: string; all?: boolean };
    result: { forgotten: string[] };
  };
  /**
   * Register the calling socket as an agent endpoint. The connection stays
   * open; `message.inbound` events for this agent are pushed to it. Exactly
   * one endpoint per `agent` id may be registered at a time.
   */
  'agent.hello': {
    params: {
      agent: string;
      /** Human-readable host description, e.g. `openclaw@2026.7.1`. */
      host?: string;
      protocolVersion?: number;
    };
    result: {
      protocolVersion: number;
      serviceDid: string | null;
      /** Wallet-issued identity for this agent, when already bootstrapped. */
      identity: AgentIdentitySummary | null;
      connection: ConnectionSnapshot;
    };
  };
  /**
   * Send an outbound frame to the connected wallet on behalf of an agent.
   * `text` frames go over the control transport; `stream` frames over the
   * stream channel when available.
   */
  'agent.send': {
    params: { agent: string; channel?: 'control' | 'stream'; payload: string };
    result: { delivered: boolean };
  };
  /**
   * Broker an arbitrary AC2 request/response round-trip against the connected
   * wallet, ENTIRELY inside the daemon — a single generic passthrough that
   * subsumes every request verb (`ac2/SigningRequest` today,
   * `ac2/KeyRequest`/attestations later) instead of one control method per
   * verb.
   *
   * This must live in the daemon — not the calling agent — because the daemon
   * owns the real wallet transport and the `Ac2Client` that receives the
   * reply: the wallet's response is a structurally-valid AC2 message, so the
   * DataChannel transport routes it to `onMessage` (the daemon's own client),
   * NOT to `onRawMessage` (the source of `message.inbound` events). An agent
   * that ran its own `Ac2Client` over the control socket would send the
   * request but never observe the reply. So the round-trip happens here, where
   * the reply lands.
   *
   * The caller supplies the request `type`, `body`, and the response `type`s
   * that settle it; the daemon stamps the authoritative `from`/`to` from the
   * current session's agent/controller DIDs (callers cannot spoof addressing)
   * and relays the wallet's raw response message back verbatim. The caller
   * interprets that message (e.g. `ac2/SigningResponse` vs
   * `ac2/SigningRejected`) itself, keeping the daemon verb-agnostic.
   */
  'agent.request': {
    params: AgentRequestParams;
    result: AgentRequestResult;
  };
  /** Subscribe the calling socket to `event` notifications. */
  subscribe: {
    params: { events?: ControlEventName[] };
    result: { subscribed: ControlEventName[] };
  };
}

export type ControlMethodName = keyof ControlMethods;

/** Runtime list of every control method (for validation). */
export const CONTROL_METHODS: readonly ControlMethodName[] = [
  'daemon.status',
  'daemon.stop',
  'pair.start',
  'pair.cancel',
  'connections.list',
  'connections.forget',
  'agent.hello',
  'agent.send',
  'agent.request',
  'subscribe',
] as const;

export function isControlMethod(value: string): value is ControlMethodName {
  return (CONTROL_METHODS as readonly string[]).includes(value);
}

/** Server → client notifications. */
export interface ControlEvents {
  /** A pairing cycle produced a fresh QR payload. */
  'connection.pairing': { requestId: string; qrPayload: string; origin: string };
  /** Wallet handshake completed; the data channel is open. */
  'connection.connected': {
    requestId: string;
    controllerDid: string | null;
    walletAddress: string | null;
    /** `true` when this session was refused (see {@link ConnectionSnapshot.locked}). */
    locked: boolean;
    /** `true` when a usable agent identity exists for this session (reused or freshly bootstrapped). */
    identityGranted: boolean;
    /** Wallet-issued DID for the default agent, when `identityGranted` is `true`. */
    agentDid: string | null;
  };
  /** The wallet channel dropped; the daemon may retry automatically. */
  'connection.disconnected': { requestId: string | null; reason: string };
  /** Wallet presence changed on the signaling server. */
  'connection.presence': { requestId: string; present: boolean };
  /**
   * Inbound wallet traffic routed to a target agent. Pushed only to the
   * socket registered (via `agent.hello`) for `agent`.
   */
  'message.inbound': {
    agent: string;
    channel: 'control' | 'stream';
    payload: string;
    controllerDid: string | null;
    requestId: string | null;
  };
  /**
   * The wallet controller opened/switched to (`open`) or closed (`close`) a
   * conversation thread.
   *
   * WHY THIS EXISTS AS AN EVENT: the wallet announces this as an AC2 protocol
   * message (`ac2/ConversationOpen` / `ac2/ConversationClose`), which the
   * daemon's own `Ac2Client` consumes — it therefore never appears as
   * `message.inbound` (that carries only raw, non-AC2 frames). Broadcasting it
   * lets a runtime adapter (and any control-socket agent) keep its notion of
   * the ACTIVE thread in step with the wallet's UI, so live activity and
   * replayed history are scoped to the thread the user is looking at.
   */
  'conversation.changed': {
    kind: 'open' | 'close';
    thid: string;
    title?: string;
    controllerDid: string | null;
    requestId: string | null;
  };
  /** An agent endpoint registered or went away. */
  'agent.registered': { agent: string };
  'agent.unregistered': { agent: string };
}

export type ControlEventName = keyof ControlEvents;

export const CONTROL_EVENTS: readonly ControlEventName[] = [
  'connection.pairing',
  'connection.connected',
  'connection.disconnected',
  'connection.presence',
  'message.inbound',
  'conversation.changed',
  'agent.registered',
  'agent.unregistered',
] as const;

/** Machine-readable error codes carried in error responses. */
export type ControlErrorCode =
  | 'bad_request' // malformed frame / unknown method / invalid params
  | 'not_connected' // wallet channel required but not open
  | 'pairing_active' // conflicting pairing cycle already running
  | 'agent_taken' // another socket already registered this agent id
  | 'not_found' // unknown requestId / connection
  | 'internal'; // unexpected daemon-side failure

export interface ControlRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface ControlSuccessResponse {
  id: number;
  result: unknown;
}

export interface ControlErrorResponse {
  id: number;
  error: { code: ControlErrorCode; message: string };
}

export interface ControlEventFrame {
  event: ControlEventName;
  data: unknown;
}

export type ControlResponse = ControlSuccessResponse | ControlErrorResponse;
export type ControlFrame = ControlRequest | ControlResponse | ControlEventFrame;

/** Snapshot of the wallet connection embedded in several results. */
export interface ConnectionSnapshot {
  state: ConnectionState;
  requestId: string | null;
  controllerDid: string | null;
  walletAddress: string | null;
  /** Liquid Auth origin the daemon signals through. */
  origin: string;
  /**
   * `true` when the daemon refused the connecting wallet because it is
   * already bound to a different controller (see `decideControllerBinding`).
   * While locked, inbound wallet traffic is dropped, but `agent.send` still
   * works so a locked agent can explain itself to the wallet.
   */
  locked: boolean;
}

/**
 * The invitation of the daemon's CURRENT pairing cycle, as first delivered by
 * the `connection.pairing` event and returned by `pair.start`.
 */
export interface PairingInvitation {
  requestId: string;
  qrPayload: string;
  origin: string;
}

export interface DaemonStatus {
  protocolVersion: number;
  version: string;
  pid: number;
  startedAt: string;
  /** did:key the daemon generated for itself via the keystore. */
  serviceDid: string | null;
  /** Socket path of the embedded keystore RPC service, if hosted. */
  keystoreSocket: string | null;
  connection: ConnectionSnapshot;
  /**
   * Invitation of the pairing cycle the daemon currently owns, or `null` when
   * no cycle is armed. Exposed READ-ONLY (unlike `pair.start`, which may start
   * one) so a client can render the QR at any time — including while a wallet
   * is already connected, since the daemon keeps the cycle (and its
   * `requestId`) alive for re-links. Without this, `pair.start` was the only
   * way to obtain the payload, so any command that must not disturb the
   * lifecycle could not show a QR at all.
   */
  pairing: PairingInvitation | null;
  agents: Array<{ agent: string; host: string | null; connectedAt: string }>;
  defaultAgent: string;
  /**
   * Id of the active runtime adapter (see `@algorandfoundation/ac2-sdk/runtime`
   * and `../runtime/loader.ts`), or `null` if none loaded (e.g. a broken
   * `AC2_RUNTIME` specifier — the daemon still runs, just with no adapter
   * attached).
   */
  runtimeAdapter: string | null;
  /**
   * `true` when the daemon is deliberately NOT awaiting a wallet yet because
   * no agent runtime is alive (see `DaemonRunOptions.waitForRuntime`). It
   * flips to `false` the moment a runtime becomes alive and pairing/resume is
   * armed. Always `false` when `waitForRuntime` is disabled.
   */
  waitingForRuntime: boolean;
}

export interface ConnectionSummary {
  requestId: string;
  createdAt: string;
  lastActiveAt: string;
  controllerDid: string | null;
  agentDid: string | null;
  conversationCount: number;
}

export interface AgentIdentitySummary {
  agentDid: string;
  controllerDid: string;
  publicKey: string;
}

/**
 * Parameters an agent submits to {@link ControlMethods."agent.request"} — the
 * generic, verb-agnostic wallet request/response passthrough.
 *
 * The caller supplies the AC2 request `type` and `body` and declares which
 * response `type`s settle the round-trip. The daemon fills the authoritative
 * `from`/`to` DIDs from the current session's agent/controller identity — a
 * caller CANNOT address the request to anyone but the connected controller —
 * builds the envelope, sends it on the wallet transport, and relays the raw
 * matching response back. Everything below is inlined (rather than imported
 * from the SDK) to keep this protocol module free of an SDK dependency,
 * matching the rest of the file.
 */
export interface AgentRequestParams {
  /**
   * Target agent whose wallet-issued identity is used as the request `from`.
   * Optional; the daemon brokers through the default agent's identity when
   * omitted (the only identity a single connected wallet issues today).
   */
  agent?: string;
  /** AC2 request message `type` URI, e.g. `ac2/SigningRequest`. */
  type: string;
  /** Verb-specific request body (e.g. a `SigningRequestBody`). */
  body: Record<string, unknown>;
  /**
   * Response `type`s that settle the round-trip, e.g.
   * `['ac2/SigningResponse', 'ac2/SigningRejected']`. Must be non-empty.
   */
  responseTypes: string[];
  /** Relative expiry (seconds from now) stamped into the request envelope. */
  expires_in_seconds?: number;
  /** Round-trip timeout in ms while awaiting the wallet (default 120000). */
  timeoutMs?: number;
}

/**
 * The wallet's response message, relayed back verbatim (minus transport
 * bookkeeping). The caller interprets `type`/`body` itself — e.g. an
 * `ac2/SigningResponse` vs an `ac2/SigningRejected`.
 */
export interface AgentRequestResponseMessage {
  /** AC2 response message `type` URI. */
  type: string;
  /** Thread id linking the response to the request (the request's `id`). */
  thid?: string;
  /** `from` DID stamped by the wallet (the controller). */
  from: string;
  /** `to` DIDs stamped by the wallet (the requesting agent). */
  to: string[];
  /** Verb-specific response body. */
  body: Record<string, unknown>;
}

/**
 * Outcome of a daemon-brokered {@link ControlMethods."agent.request"}
 * round-trip.
 *
 * `response` carries the wallet's raw reply (which may itself be an
 * approval OR an application-level rejection such as `ac2/SigningRejected` —
 * the caller decides). `unavailable` is a DAEMON-side gate that never reached
 * the wallet: `no_identity` when the session has no wallet-issued identity,
 * `locked` when the connection is refused. A missing wallet connection is
 * surfaced as a `not_connected` control error instead, so the caller can tell
 * "not paired" apart from a user decline.
 */
export type AgentRequestResult =
  | { status: 'response'; message: AgentRequestResponseMessage }
  | { status: 'unavailable'; reason: 'locked' | 'no_identity' };
