/** Transport-free AC2 flows: `signFlow`, `capabilitiesFlow`, `buildFinalizeFrame`. */

import type { BuildSigningRequestArgs, SigningOutcome } from '@algorandfoundation/ac2-sdk/protocol';
import type { SigningRequestBody, SigningResponseBody } from '@algorandfoundation/ac2-sdk/schema';
import { connectControl, type ControlClient } from '@algorandfoundation/ac2-cli/control';
import type { PluginConfig, ToolContext } from './contracts.js';
import { NoActiveSessionError, SessionManager, sessionManager } from './manager.js';
import { sessionAlgorandAddress } from './wallet-address.js';

const STREAM_CONTROL_PREFIX = '\u0002';

/** Build a `finalize` stream control frame. */
export function buildFinalizeFrame(text: string, thid = 'default'): string {
  return (
    STREAM_CONTROL_PREFIX + JSON.stringify({ t: 'finalize', thid, mid: `ac2-${Date.now()}`, text })
  );
}

export interface SignParams {
  description: string;
  payload_base64: string;
  schema?: SigningRequestBody['schema'];
  sig_hint?: SigningRequestBody['sig_hint'];
  display_hint?: SigningRequestBody['display_hint'];
  key_type?: SigningRequestBody['key_type'];
  expires_in_seconds?: number;
}

export type SignResult =
  | {
      status: 'signed';
      signature: string;
      public_key: string;
      address?: string;
      key_type?: 'account' | 'identity';
      thid: string;
    }
  | {
      status: 'rejected';
      reason: string;
      thid?: string;
    };

export interface SignDeps {
  manager?: SessionManager;
}

/** One `SigningRequest` round-trip on the active session. */
export async function signFlow(
  params: SignParams,
  config: PluginConfig,
  deps: SignDeps = {},
  context: ToolContext = {},
): Promise<SignResult> {
  const manager = deps.manager ?? sessionManager;
  const active = manager.requireActive();
  context.signal?.throwIfAborted();

  if (active.identityGranted === false) {
    return {
      status: 'rejected',
      reason: 'no_identity',
    };
  }

  const args: BuildSigningRequestArgs = {
    from: active.agentDid,
    to: active.controllerDid,
    body: {
      description: params.description,
      encoding: 'base64',
      payload: params.payload_base64,
      ...(params.schema !== undefined ? { schema: params.schema } : {}),
      ...(params.sig_hint !== undefined ? { sig_hint: params.sig_hint } : {}),
      ...(params.display_hint !== undefined ? { display_hint: params.display_hint } : {}),
      ...(params.key_type !== undefined ? { key_type: params.key_type } : {}),
    },
    ...(params.expires_in_seconds !== undefined
      ? {
          expires_time: Math.floor(Date.now() / 1000) + params.expires_in_seconds,
        }
      : {}),
  };

  const outcome: SigningOutcome = await active.client.requestSignature(args, {
    timeoutMs: config.defaultTimeoutMs ?? 120_000,
  });

  if (outcome.kind === 'rejected') {
    return {
      status: 'rejected',
      reason: outcome.message.body.reason,
      ...(outcome.message.thid !== undefined ? { thid: outcome.message.thid } : {}),
    };
  }
  const body = outcome.message.body;
  const thid = outcome.message.thid ?? '';
  return {
    status: 'signed',
    signature: body.signature,
    public_key: body.public_key,
    ...(body.address !== undefined ? { address: body.address } : {}),
    ...(body.key_type !== undefined ? { key_type: body.key_type } : {}),
    thid,
  };
}

export interface CapabilitiesResult {
  status: 'ok' | 'no_active_session';
  agent: {
    /** Agent DID, populated once an `ac2` session is active; `null` before. */
    did: string | null;
    plugin: { id: string; version: string };
    sigHintsCatalog: ReadonlyArray<SigningRequestBody['sig_hint']>;
  };
  session: {
    connected: boolean;
    /** Connected controller account, populated once a session is active. */
    controllerDid: string | null;
    /** Public Algorand account bound to the connected controller. */
    walletAddress: string | null;
  };
}

const SIG_HINTS_CATALOG = ['raw-ed25519', 'raw-secp256k1'] as const;

/** Assemble a {@link CapabilitiesResult} from the resolved connection facts. */
function buildCapabilitiesResult(facts: {
  connected: boolean;
  agentDid: string | null;
  controllerDid: string | null;
  walletAddress: string | null;
}): CapabilitiesResult {
  return {
    status: facts.connected ? 'ok' : 'no_active_session',
    agent: {
      did: facts.agentDid,
      plugin: { id: 'ac2', version: '0.1.0' },
      sigHintsCatalog: SIG_HINTS_CATALOG as unknown as ReadonlyArray<
        SigningRequestBody['sig_hint']
      >,
    },
    session: {
      connected: facts.connected,
      controllerDid: facts.controllerDid,
      walletAddress: facts.walletAddress,
    },
  };
}

/**
 * Capabilities derived from the plugin-local {@link SessionManager} — i.e. an
 * `ac2` pairing session running IN THIS process (`openclaw ac2 pair`). This is
 * the richest source when present (it holds the live transport, the agent DID
 * and the wallet address), but it is empty in the agent/gateway process where
 * tools normally execute, because the daemon — not this process — owns the
 * wallet connection now. Use {@link resolveCapabilities} to also consult the
 * daemon.
 */
export function capabilitiesFlow(_config: PluginConfig, deps: SignDeps = {}): CapabilitiesResult {
  const manager = deps.manager ?? sessionManager;
  const active = manager.getActive();
  const hasIdentity = active != null && active.identityGranted !== false;
  return buildCapabilitiesResult({
    connected: active !== null,
    agentDid: hasIdentity ? active.agentDid : null,
    controllerDid: active?.controllerDid ?? null,
    walletAddress: active ? (sessionAlgorandAddress(active) ?? null) : null,
  });
}

/** Injectable seam so the daemon-backed capability probe is unit-testable. */
export interface DaemonCapabilitiesDeps {
  /**
   * Connect to the daemon control socket read-only, resolving `undefined` when
   * the daemon is unreachable (never throws). Defaults to a short-timeout
   * {@link connectControl}.
   */
  connect?: () => Promise<ControlClient | undefined>;
}

/** Read-only, short-timeout control-socket connect that never throws. */
async function defaultDaemonConnect(): Promise<ControlClient | undefined> {
  try {
    return await connectControl({ timeoutMs: 500 });
  } catch {
    return undefined;
  }
}

/**
 * Capabilities derived from the DAEMON's live view over the control socket —
 * the same source of truth `/ac2 status` uses. Since the daemon owns the
 * wallet connection lifecycle (it resumes connections across restarts and
 * drives runs over the `openclaw-gateway` adapter), a wallet can be fully
 * connected even when no `pair` command is running in this process. Returns
 * `null` only when the daemon is unreachable (so the caller can fall back to
 * the local view); a reachable-but-idle daemon returns a `no_active_session`
 * result.
 */
export async function capabilitiesFromDaemon(
  _config: PluginConfig,
  deps: DaemonCapabilitiesDeps = {},
): Promise<CapabilitiesResult | null> {
  const connect = deps.connect ?? defaultDaemonConnect;
  const client = await connect();
  if (!client) return null;
  try {
    const status = await client.request('daemon.status', {});
    if (status.connection.state !== 'connected') {
      return buildCapabilitiesResult({
        connected: false,
        agentDid: null,
        controllerDid: null,
        walletAddress: null,
      });
    }
    // The connection snapshot has no agent DID (only the per-connection record
    // does), so look it up by requestId. A locked session is refused, so it
    // has no usable identity — report `agent.did: null` for it, mirroring the
    // local no-identity path.
    const { connections } = await client.request('connections.list', {});
    const record = connections.find((c) => c.requestId === status.connection.requestId);
    const agentDid = status.connection.locked ? null : (record?.agentDid ?? null);
    return buildCapabilitiesResult({
      connected: true,
      agentDid,
      controllerDid: status.connection.controllerDid ?? null,
      walletAddress: status.connection.walletAddress ?? null,
    });
  } finally {
    client.close();
  }
}

/** Deps for {@link resolveCapabilities}: local session + daemon probe seams. */
export interface ResolveCapabilitiesDeps extends DaemonCapabilitiesDeps {
  manager?: SessionManager;
}

/**
 * The capability view the `ac2_capabilities` tool should report. Prefers a
 * live in-process pairing session (richest), and otherwise asks the daemon —
 * which actually owns the wallet connection — so the tool reports "connected"
 * whenever a wallet is linked, not only when this process happens to be the
 * one that ran `pair`. Falls back to the (idle) local view only if the daemon
 * is unreachable.
 */
export async function resolveCapabilities(
  config: PluginConfig,
  deps: ResolveCapabilitiesDeps = {},
): Promise<CapabilitiesResult> {
  const local = capabilitiesFlow(config, deps.manager ? { manager: deps.manager } : {});
  if (local.status === 'ok') return local;
  const daemon = await capabilitiesFromDaemon(config, deps.connect ? { connect: deps.connect } : {});
  return daemon ?? local;
}

/**
 * The connection facts a wallet-account lookup needs, resolved from whichever
 * source actually owns the connection (see {@link resolveWalletAccount}).
 */
export interface ResolvedWalletAccount {
  controllerDid: string;
  walletAddress: string | null;
}

/** Deps for {@link resolveWalletAccount}: local session + daemon probe seams. */
export interface ResolveWalletAccountDeps extends DaemonCapabilitiesDeps {
  manager?: SessionManager;
}

/**
 * Resolve the connected wallet's identity (controller DID + reported address)
 * from the live connection, wherever it lives: an in-process pairing session
 * when there is one, otherwise the DAEMON's view over the control socket.
 *
 * WHY: tools that need the wallet's on-chain account (x402 payments) used to
 * read it off `sessionManager.requireActive()`, which is empty in the
 * agent/gateway process where tools actually execute — so a perfectly
 * connected wallet looked absent. Mirrors {@link resolveCapabilities} /
 * {@link resolveSign}. Returns `null` when neither source has a connection.
 */
export async function resolveWalletAccount(
  config: PluginConfig,
  deps: ResolveWalletAccountDeps = {},
): Promise<ResolvedWalletAccount | null> {
  const manager = deps.manager ?? sessionManager;
  const active = manager.getActive();
  if (active) {
    return {
      controllerDid: active.controllerDid,
      walletAddress: sessionAlgorandAddress(active) ?? null,
    };
  }
  const daemon = await capabilitiesFromDaemon(
    config,
    deps.connect ? { connect: deps.connect } : {},
  );
  if (!daemon || daemon.status !== 'ok' || daemon.session.controllerDid === null) return null;
  return {
    controllerDid: daemon.session.controllerDid,
    walletAddress: daemon.session.walletAddress,
  };
}

/** Injectable seam so the daemon-backed signing path is unit-testable. */
export interface SignViaDaemonDeps {
  /**
   * Connect to the daemon control socket, resolving `undefined` when the
   * daemon is unreachable (never throws). Defaults to a short-timeout
   * {@link connectControl}; note the socket-connect timeout is distinct from
   * the signing round-trip, which the daemon holds open while the wallet user
   * approves.
   */
  connect?: () => Promise<ControlClient | undefined>;
}

/**
 * Perform a signing round-trip through the DAEMON's generic `agent.request`
 * control method. The daemon owns the wallet transport and — crucially — the
 * only `Ac2Client` that receives the wallet's `SigningResponse` (it arrives on
 * the `onMessage` path, not the `onRawMessage`/`message.inbound` path this
 * process could observe), so an in-process `Ac2Client` over the control socket
 * would send a request it could never settle. Brokering it in the daemon is
 * the only correct path now that sessions are daemon-owned.
 *
 * `agent.request` is verb-agnostic: this builds the `ac2/SigningRequest` body
 * itself and declares the response types that settle it; the daemon stamps the
 * authoritative `from`/`to` (this process never supplies them) and relays the
 * wallet's raw reply, which we interpret here into a {@link SignResult}.
 *
 * Returns `null` only when the daemon is unreachable (so the caller can fall
 * back to any local session).
 */
export async function signViaDaemon(
  params: SignParams,
  config: PluginConfig,
  deps: SignViaDaemonDeps = {},
): Promise<SignResult | null> {
  const connect = deps.connect ?? defaultDaemonConnect;
  const client = await connect();
  if (!client) return null;
  try {
    const result = await client.request('agent.request', {
      type: 'ac2/SigningRequest',
      body: {
        description: params.description,
        encoding: 'base64',
        payload: params.payload_base64,
        ...(params.schema !== undefined ? { schema: params.schema } : {}),
        ...(params.sig_hint !== undefined ? { sig_hint: params.sig_hint } : {}),
        ...(params.display_hint !== undefined ? { display_hint: params.display_hint } : {}),
        ...(params.key_type !== undefined ? { key_type: params.key_type } : {}),
      },
      responseTypes: ['ac2/SigningResponse', 'ac2/SigningRejected'],
      ...(params.expires_in_seconds !== undefined
        ? { expires_in_seconds: params.expires_in_seconds }
        : {}),
      timeoutMs: config.defaultTimeoutMs ?? 120_000,
    });
    // A daemon-side gate (locked / no wallet-issued identity) never reached the
    // wallet — surface it as a rejection with that reason, mirroring the local
    // signing flow's `no_identity` result.
    if (result.status === 'unavailable') {
      return { status: 'rejected', reason: result.reason };
    }
    // The wallet replied: an `ac2/SigningRejected` is the user declining; an
    // `ac2/SigningResponse` carries the signature. Interpret its body here.
    const { message } = result;
    const thid = message.thid;
    if (message.type === 'ac2/SigningRejected') {
      const reason =
        typeof message.body['reason'] === 'string' ? (message.body['reason'] as string) : 'rejected';
      return { status: 'rejected', reason, ...(thid !== undefined ? { thid } : {}) };
    }
    const body = message.body as unknown as SigningResponseBody;
    return {
      status: 'signed',
      signature: body.signature,
      public_key: body.public_key,
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(body.key_type !== undefined ? { key_type: body.key_type } : {}),
      thid: thid ?? '',
    };
  } finally {
    client.close();
  }
}

/** Deps for {@link resolveSign}: local session + daemon signing seams. */
export interface ResolveSignDeps extends SignViaDaemonDeps {
  manager?: SessionManager;
}

/**
 * The signing path the `ac2_sign` tool should use. Mirrors
 * {@link resolveCapabilities}: a live in-process pairing session wins when
 * present (keeping the local flow meaningful/testable), otherwise the request
 * is brokered through the daemon that actually owns the wallet connection —
 * so signing works in the agent/gateway process where no local session exists.
 * Throws {@link NoActiveSessionError} only when neither a local session nor a
 * reachable daemon is available (matching the pre-daemon "no active session"
 * behaviour the tool already handles).
 */
export async function resolveSign(
  params: SignParams,
  config: PluginConfig,
  deps: ResolveSignDeps = {},
  context: ToolContext = {},
): Promise<SignResult> {
  const manager = deps.manager ?? sessionManager;
  if (manager.getActive()) {
    return signFlow(params, config, { manager }, context);
  }
  const daemon = await signViaDaemon(params, config, deps.connect ? { connect: deps.connect } : {});
  if (daemon) return daemon;
  throw new NoActiveSessionError(
    'No AC2 wallet connection. Ask the user to run `openclaw ac2 pair` and connect their wallet first.',
  );
}
