/**
 * The AC2 daemon runtime: wires the control socket, the wallet-connection
 * broker, the identity keystore, and (optionally) an embedded keystore RPC
 * service into one running process. `src/cli.ts` is the process-level shell
 * (signals, pidfile, detached spawn) around {@link runDaemon}.
 */

import { connect as netConnect } from 'node:net';
import type { Ac2ChannelProvider } from '@algorandfoundation/ac2-sdk/signaling';
import type { Ac2RuntimeAdapter, Ac2RuntimeInbound } from '@algorandfoundation/ac2-sdk/runtime';
import { createConnectionBroker, type ConnectionBroker } from './broker.js';
import { DEFAULT_RUNTIME_ADAPTER, loadRuntimeAdapter } from '../runtime/loader.js';
import type { SocketRuntimeHost } from '../runtime/socket-adapter.js';
import {
  createControlServer,
  type ControlClientConnection,
  type ControlServer,
} from '../control/server.js';
import {
  CONTROL_EVENTS,
  CONTROL_PROTOCOL_VERSION,
  DEFAULT_TARGET_AGENT,
  type AgentIdentitySummary,
  type ConnectionSummary,
  type ControlErrorCode,
  type ControlEventName,
  type ControlEvents,
  type DaemonStatus,
  type AgentRequestParams,
} from '../control/protocol.js';
import { clearAgentIdentities, setAc2KeyStore } from '../identity/keystore.js';
import {
  clearAc2State,
  getConnection,
  getSessionCookie,
  listConnections,
  loadAc2State,
  loadRuntimeSelection,
  saveAc2State,
  saveRuntimeSelection,
  setSessionCookie,
  type Ac2PersistedState,
  type PersistedConnection,
} from '../identity/state.js';
import { createAc2KeyStore, type Ac2KeyStore, type Ac2KeyStoreOptions } from '../keystore/index.js';

/** The daemon's own protocol/package version, reported in `daemon.status`. */
export const AC2_DAEMON_VERSION = '1.0.0-canary.1';

/** Default Liquid Auth origin when none is configured. */
const DEFAULT_ORIGIN = 'https://debug.liquidauth.com';

export interface DaemonRunOptions {
  /** Control socket path; defaults to {@link resolveControlSocketPath}. */
  socketPath?: string;
  /** Liquid Auth origin (opts → `AC2_LIQUID_AUTH_SERVER` → the default origin). */
  origin?: string;
  /** Default agent id wallet traffic is routed to (opts → `AC2_DEFAULT_AGENT` → {@link DEFAULT_TARGET_AGENT}). */
  defaultAgent?: string;
  /** Kick off pairing automatically once the daemon is listening (default `false`). */
  autoPair?: boolean;
  /**
   * On startup, when a previously-paired connection is persisted, automatically
   * re-arm the pairing cycle so the daemon is already *awaiting the wallet's
   * re-link* on the SAME `requestId` (no rescan). This is what lets a returning
   * wallet reconnect after a daemon restart without a manual `ac2 pair`.
   * Default `true`; independent of {@link autoPair} (which issues a brand-new
   * pairing/QR even when nothing has ever paired).
   */
  resumeConnections?: boolean;
  /**
   * Do not arm pairing/resume (i.e. do not start *awaiting a wallet*) until
   * at least one agent runtime is ALIVE — so a wallet is never left talking
   * to a service that has no agent behind it. "Alive" means: the active
   * runtime adapter reported ready (see `Ac2RuntimeHost.reportRuntimeReady`;
   * e.g. the `openclaw-gateway` adapter's WS handshake completed), or — for a
   * `socket`-style adapter whose liveness the daemon observes directly — an
   * agent registered via `agent.hello`. Default `true`; disable with
   * `AC2_WAIT_FOR_RUNTIME=0` (or `false`/`no`/`off`) or this option to restore
   * the legacy "arm immediately on startup" behaviour.
   */
  waitForRuntime?: boolean;
  /** Keystore wiring (state dir, keychain service, injectable test seams). */
  keystore?: Ac2KeyStoreOptions;
  /** Line logger (default `console.log`); an ISO timestamp is prefixed. */
  log?: (line: string) => void;
  /** Test seam: overrides the broker's channel-provider factory. */
  providerFactory?: (requestId?: string) => Ac2ChannelProvider;
  /** Socket path probed/hosted for the embedded keystore RPC service. */
  keystoreSocketPath?: string;
  /** Host the keystore RPC service when nothing else already does (default `true`). */
  hostKeystore?: boolean;
  /** Install SIGTERM/SIGINT handlers that gracefully stop the daemon (default `true`). */
  handleSignals?: boolean;
  /**
   * Runtime adapter wiring (opts → `AC2_RUNTIME`/`AC2_RUNTIME_CONFIG` env →
   * the built-in `socket` default). See `../runtime/loader.ts`.
   */
  runtime?: {
    /** Built-in short name or npm package specifier; see `loadRuntimeAdapter`. */
    adapter?: string;
    /** Config object handed to the adapter's `createRuntimeAdapter(host, config)`. */
    config?: Record<string, unknown>;
  };
}

export interface RunningDaemon {
  /** The control socket the daemon actually bound. */
  socketPath: string;
  /** A fresh {@link DaemonStatus} snapshot. */
  status(): DaemonStatus;
  /** Gracefully stop the daemon (idempotent). */
  stop(): Promise<void>;
  /** Resolves once shutdown has fully completed. */
  closed: Promise<void>;
}

/** First non-empty (after trimming) string among `values`, else `undefined`. */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Resolve the effective {@link DaemonRunOptions.waitForRuntime} flag:
 * explicit option → `AC2_WAIT_FOR_RUNTIME` env → default `true`. Any of
 * `0`/`false`/`no`/`off` (case-insensitive) disables the wait.
 */
function resolveWaitForRuntime(options: DaemonRunOptions, env: NodeJS.ProcessEnv): boolean {
  if (options.waitForRuntime !== undefined) return options.waitForRuntime;
  const raw = firstNonEmpty(env['AC2_WAIT_FOR_RUNTIME']);
  if (raw === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

/** Where a resolved runtime-adapter spec came from (see {@link resolveRuntimeAdapterSpec}). */
type RuntimeAdapterSource = 'explicit' | 'env' | 'persisted' | 'default';

/**
 * Resolve which runtime adapter to load and its config, per the documented
 * precedence: explicit `options.runtime.adapter` → `AC2_RUNTIME` env (config
 * from `options.runtime.config`, else `AC2_RUNTIME_CONFIG` parsed as JSON) →
 * the adapter PERSISTED from a prior explicit selection (so a bare
 * `service start`/restart and the env-less OS supervision unit keep the chosen
 * backend, see `saveRuntimeSelection`) → the built-in `socket` default.
 * Malformed `AC2_RUNTIME_CONFIG` is tolerated: logged once and treated as `{}`,
 * never thrown. The `source` tells the caller whether to persist the choice
 * (only `explicit`/`env` are remembered — never the fallback default, and a
 * `persisted` result is already on disk).
 */
function resolveRuntimeAdapterSpec(
  options: DaemonRunOptions,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): { specifier: string; config: Record<string, unknown>; source: RuntimeAdapterSource } {
  const explicitAdapter = options.runtime?.adapter;
  if (explicitAdapter !== undefined && explicitAdapter.trim().length > 0) {
    return { specifier: explicitAdapter, config: options.runtime?.config ?? {}, source: 'explicit' };
  }

  const envAdapter = firstNonEmpty(env['AC2_RUNTIME']);
  if (envAdapter !== undefined) {
    if (options.runtime?.config !== undefined) {
      return { specifier: envAdapter, config: options.runtime.config, source: 'env' };
    }
    const rawConfig = env['AC2_RUNTIME_CONFIG'];
    if (rawConfig === undefined || rawConfig.trim().length === 0) {
      return { specifier: envAdapter, config: {}, source: 'env' };
    }
    try {
      const parsed: unknown = JSON.parse(rawConfig);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { specifier: envAdapter, config: parsed as Record<string, unknown>, source: 'env' };
      }
      log('[ac2] AC2_RUNTIME_CONFIG ignored: expected a JSON object, using {}');
    } catch (err) {
      log(`[ac2] AC2_RUNTIME_CONFIG is not valid JSON, ignoring it (${(err as Error).message})`);
    }
    return { specifier: envAdapter, config: {}, source: 'env' };
  }

  // Nothing explicit: reuse the adapter persisted from a prior explicit
  // selection, so a bare restart (and the env-less OS supervision unit) keeps
  // the chosen backend instead of reverting to `socket`. This is what stops a
  // service that was put on `openclaw-gateway` from silently going idle after
  // a plain `ac2 service start`.
  const persisted = loadRuntimeSelection();
  if (persisted !== undefined) {
    log(`[ac2] reusing persisted runtime adapter "${persisted.adapter}" (set an explicit AC2_RUNTIME to override)`);
    return { specifier: persisted.adapter, config: persisted.config ?? {}, source: 'persisted' };
  }

  return { specifier: DEFAULT_RUNTIME_ADAPTER, config: options.runtime?.config ?? {}, source: 'default' };
}

/** Error thrown by request handlers so `createControlServer` reports the right code. */
class ControlError extends Error {
  constructor(
    message: string,
    readonly code: ControlErrorCode,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

/** Lazily loads the Liquid Auth provider so tests that inject `providerFactory` never load `wrtc`. */
function createLazyLiquidAuthProvider(requestId: string | undefined, origin: string): Ac2ChannelProvider {
  return {
    async startPairing(opts) {
      const { LiquidAuthChannelProvider } = await import(
        '@algorandfoundation/ac2-sdk/providers/liquid-auth'
      );
      const provider = new LiquidAuthChannelProvider({
        origin,
        ...(requestId !== undefined ? { requestId } : {}),
        // The SDK has no notion of the CLI's on-disk state — adapt the CLI's
        // own session-cookie persistence (`identity/state.ts`) so the daemon
        // still reuses the same signaling session across restarts.
        sessionCookie: {
          get: (key: string): string | undefined => getSessionCookie(key),
          set: (key: string, cookie: string): void => {
            setSessionCookie(key, cookie);
          },
        },
      });
      return provider.startPairing(opts);
    },
  };
}

/** Probe a socket path; resolves `true` when something is already listening there. */
function probeSocket(path: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect(path);
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

/**
 * Serve the daemon's own keystore over the keystore-node RPC protocol, so other
 * tools (`keystore …`, wallets, future agents) share the very same keys instead
 * of opening a second store. Never throws: on any failure it logs once and
 * returns `{ path: null }` so the daemon keeps running without the service.
 */
async function hostEmbeddedKeystore(
  path: string,
  identityKeystore: Ac2KeyStore,
  log: (line: string) => void,
): Promise<{ path: string | null; close: () => Promise<void> }> {
  try {
    const { createKeyStoreRpcServer } = await import('@algorandfoundation/keystore-node');
    await identityKeystore.ready;
    const server = createKeyStoreRpcServer({
      keystore: identityKeystore.keystore,
      store: identityKeystore.store,
      path,
    });
    const boundPath = await server.listen();
    log(`[ac2] keystore RPC listening on ${boundPath}`);
    return { path: boundPath, close: () => server.close() };
  } catch (err) {
    log(`[ac2] failed to host keystore service: ${(err as Error).message}`);
    return { path: null, close: async () => {} };
  }
}

/** Forget a single persisted connection (state only — see `connections.forget`). */
function forgetConnection(requestId: string): void {
  const state = loadAc2State();
  const connections = { ...(state.connections ?? {}) };
  delete connections[requestId];
  const next: Ac2PersistedState = { ...state, connections };
  if (next.activeRequestId === requestId) delete next.activeRequestId;
  if (next.requestId === requestId) delete next.requestId;
  // `saveAc2State` merges onto the CURRENT on-disk state, which would keep a
  // stale `activeRequestId`/`requestId` mirror; clear first so `next` fully
  // replaces it.
  clearAc2State();
  saveAc2State(next);
}

/**
 * Resolve which previously-paired connection to resume on startup: prefer the
 * active `requestId` mirror, else the most-recently-active persisted
 * connection. Returns `undefined` when nothing has ever paired (a fresh
 * install), so a brand-new daemon stays idle until the operator pairs.
 */
function resolveResumeRequestId(): string | undefined {
  const persisted = loadAc2State();
  const mirror = persisted.requestId?.trim();
  if (mirror) return mirror;
  return listConnections()[0]?.requestId;
}

/** Project a {@link PersistedConnection} into the wire-level {@link ConnectionSummary}. */
function toConnectionSummary(connection: PersistedConnection): ConnectionSummary {
  return {
    requestId: connection.requestId,
    createdAt: new Date(connection.createdAt).toISOString(),
    lastActiveAt: new Date(connection.lastActiveAt).toISOString(),
    controllerDid: connection.identity?.controllerDid ?? null,
    agentDid: connection.identity?.agentDid ?? null,
    conversationCount: Object.keys(connection.conversations ?? {}).length,
  };
}

/** Build, wire, and start the AC2 daemon (control socket + broker + keystore). */
export async function runDaemon(options: DaemonRunOptions = {}): Promise<RunningDaemon> {
  const env = process.env;
  const rawLog = options.log ?? ((line: string) => console.log(line));
  const log = (line: string): void => rawLog(`${new Date().toISOString()} ${line}`);

  const defaultAgent =
    firstNonEmpty(options.defaultAgent, env['AC2_DEFAULT_AGENT']) ?? DEFAULT_TARGET_AGENT;
  const origin = firstNonEmpty(options.origin, env['AC2_LIQUID_AUTH_SERVER']) ?? DEFAULT_ORIGIN;
  const hostKeystoreOpt = options.hostKeystore ?? true;
  const handleSignals = options.handleSignals ?? true;
  const autoPair = options.autoPair ?? false;
  const resumeConnections = options.resumeConnections ?? true;
  const waitForRuntime = resolveWaitForRuntime(options, env);

  // --- Runtime-liveness gating for "start awaiting a wallet" ---
  // `armPairing()` (autoPair or resume) is deferred until a runtime is alive
  // when `waitForRuntime` is on. `pairingArmed` makes arming idempotent;
  // `armOnAgentHello` is set when the active adapter's liveness is observed
  // via control-socket `agent.hello` (the `socket`-style adapters), rather
  // than via `host.reportRuntimeReady()`; `waitingForRuntime` is surfaced in
  // `daemon.status`.
  let pairingArmed = false;
  let armOnAgentHello = false;
  let waitingForRuntime = false;

  const identityKeystore = createAc2KeyStore({ log, ...(options.keystore ?? {}) });
  // The identity helpers (`recordAgentIdentity`, `clearAgentIdentities`, …) reach
  // for a process-wide keystore; hand them this one so the daemon never opens a
  // second engine onto the same keychain entries.
  setAc2KeyStore(identityKeystore);

  const agentClients = new Map<string, ControlClientConnection>();
  const agentMeta = new Map<string, { host: string | null; connectedAt: string }>();
  const startedAt = new Date().toISOString();

  let keystoreSocket: string | null = null;
  let closeKeystoreRpc: (() => Promise<void>) | null = null;

  // Runtime adapter (see `../runtime/`): `activeAdapter` is `null` until it
  // has loaded (or forever, if loading failed — see `loadAndStartRuntimeAdapter`
  // below). A daemon with no adapter attached still runs normally; it just
  // never gets `onConnected`/`handleInbound`/`onDisconnected`/`stop` calls.
  let activeAdapter: Ac2RuntimeAdapter | null = null;
  let activeAdapterId: string | null = null;

  /**
   * Invoke one optional adapter hook, catching and logging any failure
   * (thrown synchronously or via a rejected promise) so a broken adapter can
   * never tear down the wallet connection or the daemon — see the `Ac2RuntimeAdapter`
   * JSDoc in `@algorandfoundation/ac2-sdk/runtime` for this guarantee.
   */
  function runAdapterHook(label: string, hook: () => void | Promise<void> | undefined): void {
    if (!activeAdapter) return;
    const adapterId = activeAdapter.id;
    Promise.resolve()
      .then(hook)
      .catch((err: unknown) => {
        log(`[ac2] runtime adapter "${adapterId}" ${label} failed: ${(err as Error).message}`);
      });
  }

  /**
   * Fan out a broker event. `message.inbound` is delivered EXCLUSIVELY
   * through the active runtime adapter's `handleInbound` (the built-in
   * `socket` adapter reproduces the historical per-agent-socket fan-out —
   * see `../runtime/socket-adapter.ts`); every other event is broadcast to
   * subscribed control-socket clients exactly as before, and additionally
   * drives the matching adapter lifecycle hook.
   */
  function emitEvent<E extends ControlEventName>(event: E, data: ControlEvents[E]): void {
    if (event === 'message.inbound') {
      const inbound = data as ControlEvents['message.inbound'];
      const message: Ac2RuntimeInbound = {
        channel: inbound.channel,
        payload: inbound.payload,
        controllerDid: inbound.controllerDid,
        requestId: inbound.requestId,
      };
      runAdapterHook('handleInbound', () => activeAdapter?.handleInbound(message));
      return;
    }
    server.broadcast(event, data);
    if (event === 'connection.connected') {
      const info = data as ControlEvents['connection.connected'];
      runAdapterHook('onConnected', () => activeAdapter?.onConnected?.(info));
    } else if (event === 'connection.disconnected') {
      const { reason } = data as ControlEvents['connection.disconnected'];
      runAdapterHook('onDisconnected', () => activeAdapter?.onDisconnected?.(reason));
    } else if (event === 'conversation.changed') {
      // The wallet opened/switched/closed a thread. Broadcast above (so a
      // control-socket agent sees it too) AND hand it to the adapter, which
      // uses it to scope live activity + history replay to that thread.
      const change = data as ControlEvents['conversation.changed'];
      runAdapterHook('onConversation', () =>
        activeAdapter?.onConversation?.({
          kind: change.kind,
          thid: change.thid,
          ...(change.title !== undefined ? { title: change.title } : {}),
          controllerDid: change.controllerDid,
        }),
      );
    }
  }

  const broker: ConnectionBroker = createConnectionBroker({
    providerFactory:
      options.providerFactory ?? ((requestId) => createLazyLiquidAuthProvider(requestId, origin)),
    defaultAgent,
    origin,
    keystore: identityKeystore,
    emit: emitEvent,
    log,
  });

  // The host handed to the runtime adapter. Only the built-in `socket`
  // adapter reads `deliverInboundToAgentSocket` (a `SocketRuntimeHost`-only
  // capability); a third-party adapter loaded via `loadRuntimeAdapter` sees
  // this as a plain `Ac2RuntimeHost` and never notices the extra field.
  const runtimeHost: SocketRuntimeHost = {
    agent: defaultAgent,
    get serviceDid() {
      return broker.serviceDid();
    },
    log,
    reportRuntimeReady(): void {
      // The active adapter's runtime is alive (e.g. the gateway handshake
      // completed). If we were holding off awaiting a wallet, arm now.
      armPairingOnce('runtime adapter reported ready');
    },
    async send(payload, channel = 'control') {
      const result = await broker.send(defaultAgent, channel, payload);
      return result.delivered;
    },
    deliverInboundToAgentSocket(message: Ac2RuntimeInbound): void {
      const target = agentClients.get(defaultAgent);
      if (!target) return;
      server.sendEvent(target, 'message.inbound', {
        agent: defaultAgent,
        channel: message.channel,
        payload: message.payload,
        controllerDid: message.controllerDid,
        requestId: message.requestId,
      });
    },
  };

  /**
   * Arm pairing/resume: kick off a brand-new pairing cycle ({@link autoPair})
   * or re-arm the persisted connection ({@link resumeConnections}). This is
   * the moment the daemon starts *awaiting a wallet*; it is gated on runtime
   * liveness (see {@link armPairingOnce} and the startup block below).
   */
  function armPairing(): void {
    if (autoPair) {
      broker.startPairing().catch((err) => {
        log(`[ac2] auto-pair failed: ${(err as Error).message}`);
      });
      return;
    }
    if (!resumeConnections) return;
    const resumeRequestId = resolveResumeRequestId();
    if (!resumeRequestId) return;
    // `beginPairing` picks up `loadAc2State().requestId`; older state may
    // only carry the connection under `connections`, so mirror it first.
    if (!firstNonEmpty(loadAc2State().requestId)) {
      saveAc2State({ requestId: resumeRequestId });
    }
    log(`[ac2] resuming existing connection ${resumeRequestId} — awaiting wallet re-link.`);
    broker.startPairing().catch((err) => {
      log(`[ac2] failed to resume existing connection: ${(err as Error).message}`);
    });
  }

  /**
   * Arm pairing exactly once, clearing the "waiting for a runtime" state.
   * Idempotent: the first live-runtime signal wins, whether it comes from
   * `host.reportRuntimeReady()` or a control-socket `agent.hello`.
   */
  function armPairingOnce(reason: string): void {
    if (pairingArmed) return;
    pairingArmed = true;
    if (waitingForRuntime) {
      waitingForRuntime = false;
      log(`[ac2] a runtime is alive (${reason}) — now awaiting a wallet.`);
    }
    armPairing();
  }

  /**
   * Load and start the configured runtime adapter. Never throws: a load
   * failure (bad specifier, missing export, throwing factory, bad shape) or
   * a throwing `start()` is logged and leaves `activeAdapter` `null` — the
   * daemon keeps running with no adapter attached.
   */
  async function loadAndStartRuntimeAdapter(): Promise<void> {
    const { specifier, config, source } = resolveRuntimeAdapterSpec(options, env, log);
    let adapter: Ac2RuntimeAdapter;
    try {
      adapter = await loadRuntimeAdapter(specifier, runtimeHost, config);
    } catch (err) {
      log(`[ac2] ${(err as Error).message}`);
      return;
    }
    activeAdapter = adapter;
    activeAdapterId = adapter.id;
    log(`[ac2] runtime adapter active: ${adapter.id}`);
    // Remember an EXPLICITLY-chosen adapter (opts/env) so a later bare restart
    // — or the env-less OS supervision unit — reuses it instead of reverting to
    // the `socket` default. Only after a successful load (never remember a
    // selection that failed to load), and persist the operator's SPECIFIER, not
    // the adapter's resolved `id`. A `persisted`/`default` source is not
    // re-persisted (no churn, and the fallback default is never remembered).
    if (source === 'explicit' || source === 'env') {
      saveRuntimeSelection({ adapter: specifier, config });
    }
    try {
      await adapter.start?.();
    } catch (err) {
      log(`[ac2] runtime adapter "${adapter.id}" start failed: ${(err as Error).message}`);
    }
  }

  function buildStatus(): DaemonStatus {
    return {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      version: AC2_DAEMON_VERSION,
      pid: process.pid,
      startedAt,
      serviceDid: broker.serviceDid(),
      keystoreSocket,
      connection: broker.snapshot(),
      // Read-only view of the live invitation: clients (the `ac2` CLI, the
      // OpenClaw plugin) can render the QR without calling `pair.start`, which
      // could otherwise disturb a running cycle just to read its payload.
      pairing: broker.currentPairing(),
      agents: [...agentMeta.entries()].map(([agent, meta]) => ({
        agent,
        host: meta.host,
        connectedAt: meta.connectedAt,
      })),
      defaultAgent,
      runtimeAdapter: activeAdapterId,
      waitingForRuntime,
    };
  }

  async function handleRequest(
    client: ControlClientConnection,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case 'daemon.status':
        return buildStatus();

      case 'daemon.stop': {
        // Respond first, then tear down once the frame has been flushed.
        setImmediate(() => {
          void stop();
        });
        return { stopping: true };
      }

      case 'pair.start': {
        const { timeoutMs } = (params ?? {}) as { timeoutMs?: number };
        return broker.startPairing(timeoutMs !== undefined ? { timeoutMs } : {});
      }

      case 'pair.cancel': {
        await broker.stopPairing();
        return { cancelled: true };
      }

      case 'connections.list': {
        return { connections: listConnections().map(toConnectionSummary) };
      }

      case 'connections.forget': {
        const { requestId, all } = (params ?? {}) as { requestId?: string; all?: boolean };
        if (all) {
          // Forgetting connections/identities must NOT change WHICH backend the
          // service runs — that is a separate, deliberate choice. Preserve the
          // remembered runtime adapter across a full wipe so the next restart
          // doesn't silently revert to `socket` and sit idle.
          const rememberedRuntime = loadRuntimeSelection();
          clearAc2State();
          if (rememberedRuntime) saveRuntimeSelection(rememberedRuntime);
          await clearAgentIdentities();
          return { forgotten: ['*'] };
        }
        if (!requestId) {
          throw new ControlError('connections.forget requires requestId or all', 'bad_request');
        }
        if (!getConnection(requestId)) {
          throw new ControlError(`unknown connection: ${requestId}`, 'not_found');
        }
        forgetConnection(requestId);
        return { forgotten: [requestId] };
      }

      case 'agent.hello': {
        const { agent, host } = (params ?? {}) as { agent: string; host?: string };
        if (typeof agent !== 'string' || agent.length === 0) {
          throw new ControlError('agent.hello requires a non-empty agent id', 'bad_request');
        }
        const existing = agentClients.get(agent);
        if (existing && existing !== client) {
          throw new ControlError(`agent already registered: ${agent}`, 'agent_taken');
        }
        client.agent = agent;
        agentClients.set(agent, client);
        agentMeta.set(agent, { host: host ?? null, connectedAt: new Date().toISOString() });
        client.subscriptions.add('message.inbound');
        server.broadcast('agent.registered', { agent });

        // A control-socket agent registering is the liveness signal for a
        // `socket`-style adapter (one that does NOT manage its own readiness
        // — see the startup gate). If we were holding off awaiting a wallet,
        // this arms it now.
        if (armOnAgentHello) armPairingOnce(`agent "${agent}" registered`);

        const persisted = loadAc2State().identity;
        const identity: AgentIdentitySummary | null = persisted
          ? {
              agentDid: persisted.agentDid,
              controllerDid: persisted.controllerDid,
              publicKey: persisted.publicKey,
            }
          : null;
        return {
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          serviceDid: broker.serviceDid(),
          identity,
          connection: broker.snapshot(),
        };
      }

      case 'agent.send': {
        const { agent, channel, payload } = (params ?? {}) as {
          agent: string;
          channel?: 'control' | 'stream';
          payload: string;
        };
        return broker.send(agent, channel ?? 'control', payload);
      }

      case 'agent.request': {
        const request = (params ?? {}) as AgentRequestParams;
        if (
          typeof request.type !== 'string' ||
          request.type.length === 0 ||
          typeof request.body !== 'object' ||
          request.body === null ||
          !Array.isArray(request.responseTypes) ||
          request.responseTypes.length === 0
        ) {
          throw new ControlError(
            'agent.request requires a non-empty string type, an object body, and a non-empty responseTypes array',
            'bad_request',
          );
        }
        // Reject early with a distinct code when there is no wallet to broker
        // through, so the caller can tell "not paired" apart from a user
        // rejection. `broker.request` also guards internally.
        if (broker.snapshot().state !== 'connected') {
          throw new ControlError('no connected wallet to send an AC2 request to', 'not_connected');
        }
        return broker.request(
          {
            type: request.type,
            body: request.body,
            responseTypes: request.responseTypes,
            ...(request.expires_in_seconds !== undefined
              ? { expires_in_seconds: request.expires_in_seconds }
              : {}),
          },
          request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {},
        );
      }

      case 'subscribe': {
        const { events } = (params ?? {}) as { events?: ControlEventName[] };
        const list = events && events.length > 0 ? events : [...CONTROL_EVENTS];
        for (const event of list) client.subscriptions.add(event);
        return { subscribed: [...client.subscriptions] };
      }

      default:
        throw new ControlError(`unknown method: ${method}`, 'bad_request');
    }
  }

  let stopping: Promise<void> | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  async function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      log('[ac2] shutting down…');
      if (activeAdapter) {
        try {
          await activeAdapter.stop?.();
        } catch (err) {
          log(`[ac2] runtime adapter "${activeAdapter.id}" stop failed: ${(err as Error).message}`);
        }
      }
      try {
        await broker.stop();
      } catch (err) {
        log(`[ac2] broker stop failed: ${(err as Error).message}`);
      }
      try {
        await server.close();
      } catch (err) {
        log(`[ac2] control server close failed: ${(err as Error).message}`);
      }
      if (closeKeystoreRpc) {
        try {
          await closeKeystoreRpc();
        } catch (err) {
          log(`[ac2] keystore service close failed: ${(err as Error).message}`);
        }
      }
      setAc2KeyStore(undefined);
      resolveClosed();
    })();
    return stopping;
  }

  const server: ControlServer = createControlServer({
    ...(options.socketPath !== undefined ? { path: options.socketPath } : {}),
    handler: handleRequest,
    onClientClosed: (client) => {
      if (client.agent) {
        agentClients.delete(client.agent);
        agentMeta.delete(client.agent);
        server.broadcast('agent.unregistered', { agent: client.agent });
      }
    },
  });

  const socketPath = await server.listen();
  await broker.start();
  await loadAndStartRuntimeAdapter();

  if (hostKeystoreOpt) {
    try {
      const { defaultRpcSocketPath } = await import('@algorandfoundation/keystore-node');
      const targetPath = options.keystoreSocketPath ?? defaultRpcSocketPath();
      const alive = await probeSocket(targetPath);
      if (alive) {
        log('[ac2] reusing existing keystore service');
        keystoreSocket = targetPath;
      } else {
        const hosted = await hostEmbeddedKeystore(targetPath, identityKeystore, log);
        keystoreSocket = hosted.path;
        closeKeystoreRpc = hosted.close;
      }
    } catch (err) {
      log(`[ac2] keystore hosting unavailable: ${(err as Error).message}`);
      keystoreSocket = null;
    }
  }

  // Decide WHEN to start awaiting a wallet (autoPair or resume). Historically
  // the daemon armed immediately here; now — unless `waitForRuntime` is off —
  // it defers until at least one agent runtime is alive, so a returning wallet
  // is never re-linked to a service that has no agent behind it (the wallet
  // would just sit there with nothing able to answer it). Liveness arrives
  // either from `host.reportRuntimeReady()` (an adapter that manages its own
  // runtime, e.g. `openclaw-gateway`) or, for a `socket`-style adapter, from a
  // control-socket `agent.hello`.
  if (!waitForRuntime) {
    // Legacy behaviour: arm immediately, regardless of runtime liveness.
    armPairingOnce('waitForRuntime disabled');
  } else if (pairingArmed) {
    // A runtime already reported ready during startup (e.g. a synchronous
    // in-process adapter) — nothing to defer.
  } else if ((activeAdapter as Ac2RuntimeAdapter | null)?.managesOwnReadiness === true) {
    // `activeAdapter` is assigned inside `loadAndStartRuntimeAdapter` (a
    // closure), which TS's control-flow analysis does not track here — hence
    // the cast back to its declared type. The adapter owns its runtime and
    // will call `reportRuntimeReady()` when it is alive; hold off until then.
    waitingForRuntime = true;
    log('[ac2] not awaiting a wallet yet — waiting for the runtime adapter to report ready.');
  } else {
    // A `socket`-style adapter (or no adapter loaded): the runtime is a
    // control-socket agent — wait for its `agent.hello` before awaiting a
    // wallet.
    armOnAgentHello = true;
    waitingForRuntime = true;
    log('[ac2] not awaiting a wallet yet — waiting for an agent to register.');
  }

  if (handleSignals) {
    const onSignal = (): void => {
      log('[ac2] received signal, shutting down…');
      void stop().then(() => process.exit(0));
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  }

  log(`[ac2] daemon listening on ${socketPath}`);

  return {
    socketPath,
    status: buildStatus,
    stop,
    closed,
  };
}
