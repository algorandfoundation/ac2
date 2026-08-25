/**
 * Reusable "agent session" client for the AC2 daemon control socket.
 *
 * The daemon owns the Liquid Auth pairing lifecycle, the wallet channel, and
 * identity persistence — an agent process (the OpenClaw plugin, Hermes, or
 * any future host) should never open its own wallet connection. Instead it
 * calls {@link connectAgentSession}, which:
 *
 * 1. Ensures a daemon is actually running, auto-starting a detached one when
 *    it isn't ({@link ensureDaemonRunning}).
 * 2. Connects the typed control-socket client and subscribes to the events
 *    the caller asked for *before* performing `agent.hello`, so nothing can
 *    slip through the gap between registering and the caller attaching its
 *    own listeners.
 * 3. Registers the agent id and surfaces the bits of session state an agent
 *    needs (protocol version, service DID, granted identity, connection
 *    snapshot) without leaking the rest of the wire protocol.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDaemonPid, startDetached, stopDaemonProcess } from '../daemon/manager.js';
import { readStartupFailure } from '../daemon/startup-report.js';
import { daemonLiveness, type DaemonLivenessOptions } from '../daemon/liveness.js';
import { AC2_DAEMON_VERSION, FALLBACK_DAEMON_VERSION } from '../daemon/version.js';
import {
  ControlRequestError,
  connectControl,
  type ControlClient,
  type ControlClientOptions,
  type ControlEventHandler,
} from './client.js';
import {
  CONTROL_EVENTS,
  CONTROL_PROTOCOL_VERSION,
  type AgentIdentitySummary,
  type ConnectionSnapshot,
  type ControlEventName,
  type DaemonStatus,
} from './protocol.js';

/**
 * Resolve this package's own CLI entry point, so {@link ensureDaemonRunning}
 * can spawn `node <entry> service run` without depending on `ac2` being on
 * `PATH`.
 *
 * `scripts/bundle.mjs` flattens every source file to the top of `dist/`
 * (`src/cli.ts` -> `dist/cli.js`, `src/control/agent.ts` ->
 * `dist/control.agent.js`), so in the published build the CLI entry is a
 * *sibling* of this file. When running from source (this file still nested
 * under `src/control/`), the CLI entry is one directory up instead. Rather
 * than assume either layout, every plausible candidate is probed on disk and
 * the first one that exists wins — this keeps the resolver correct whether
 * it runs from `src/`, an unflattened `tsc` output, or the flattened bundle.
 */
export function resolveOwnCliPath(moduleUrl: string = import.meta.url): string {
  const here = fileURLToPath(moduleUrl);
  const dir = dirname(here);
  const candidates = [
    join(dir, 'cli.js'), // flattened dist: control.agent.js + cli.js side by side
    join(dir, '..', 'cli.js'), // unflattened dist / compiled-in-place: dist/control/agent.js -> dist/cli.js
    join(dir, '..', 'cli.ts'), // source layout: src/control/agent.ts -> src/cli.ts
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Nothing on disk matched (e.g. a bundler that inlines/renames files):
  // fall back to the source-layout guess so the error surfaces clearly if
  // the spawn actually fails, instead of silently picking the wrong file.
  return candidates[1]!;
}

export interface EnsureDaemonRunningOptions {
  /** Environment passed to the spawned daemon and used to locate its pidfile/socket (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Control socket path to poll; defaults to {@link resolveControlSocketPath}. */
  socketPath?: string;
  /** Overall deadline in milliseconds to reach a listening daemon (default 5000). */
  timeoutMs?: number;
  /**
   * Version this build expects the running daemon to be. A reachable daemon
   * reporting a *different* version is treated as stale and restarted (see
   * {@link ensureDaemonRunning}). Defaults to {@link AC2_DAEMON_VERSION} — the
   * version of the CLI THIS process would spawn — so an agent host that was
   * upgraded transparently refreshes a daemon left running from the older
   * install. Pass `null` to disable the version check entirely.
   */
  expectedVersion?: string | null;
  /**
   * Runtime adapter this caller needs the daemon to be running (see
   * `../runtime/loader.ts`). A reachable daemon reporting a *different*
   * adapter is restarted exactly like a stale one, because the adapter is
   * chosen once at daemon startup and can never be switched in place.
   *
   * Defaults to `AC2_RUNTIME` from `env` when set — an agent host that needs
   * a specific backend sets that variable before calling (the OpenClaw plugin
   * sets `AC2_RUNTIME=openclaw-gateway` in `ac2 pair`), and the daemon this
   * function would spawn inherits it, so it is the authoritative statement of
   * "which adapter this process expects". Pass `null` to disable the check.
   */
  expectedRuntimeAdapter?: string | null;
  /** Line logger for restart notices (default `console.log`). */
  log?: (message: string) => void;
  /**
   * This process's own pid, used to refuse restarting an IN-PROCESS daemon
   * ({@link isSelfHostedDaemon}). Test seam only — defaults to `process.pid`.
   */
  selfPid?: number;
}

/**
 * Decide whether a reachable daemon is running stale code and must be
 * restarted. Pure so the restart policy is unit-testable without spawning.
 *
 * A restart is warranted only when both versions are known and differ. An
 * unknown running version (an older daemon that predates version reporting)
 * or an unknown *expected* version (a build whose `package.json` could not be
 * resolved — see {@link FALLBACK_DAEMON_VERSION}) is left alone rather than
 * risk cycling a healthy daemon on a comparison we cannot trust.
 */
export function isStaleDaemonVersion(
  runningVersion: string | undefined,
  expectedVersion: string | null,
): boolean {
  if (!runningVersion) return false;
  if (expectedVersion === null || expectedVersion === FALLBACK_DAEMON_VERSION) return false;
  return runningVersion !== expectedVersion;
}

/**
 * Decide whether a reachable daemon is running the wrong runtime adapter and
 * must be restarted. Pure so the restart policy is unit-testable.
 *
 * The adapter is resolved once, at daemon startup (`resolveRuntimeAdapterSpec`
 * in `daemon/run.ts`), and no control request can swap it afterwards — so a
 * daemon that came up on the built-in `socket` adapter (e.g. started by a bare
 * `ac2 service start`, or by an install predating the gateway adapter) keeps
 * routing wallet frames to a control-socket agent that is not there. The
 * wallet then pairs and reports "connected" while every turn goes nowhere.
 * Restarting is the only way to apply the caller's choice.
 *
 * Mirrors {@link isStaleDaemonVersion}'s conservative policy: an unknown
 * running adapter (`null`/absent — e.g. a broken specifier left the daemon
 * with no adapter attached) or no expectation at all is left alone rather
 * than risk cycling a daemon on a comparison we cannot trust.
 */
export function isRuntimeAdapterMismatch(
  runningAdapter: string | null | undefined,
  expectedAdapter: string | null,
): boolean {
  if (expectedAdapter === null || expectedAdapter.length === 0) return false;
  if (runningAdapter === null || runningAdapter === undefined || runningAdapter.length === 0) {
    return false;
  }
  return runningAdapter !== expectedAdapter;
}

/**
 * Whether the "daemon" this launcher would restart is in fact hosted INSIDE
 * the calling process, in which case it must never be stopped: the restart
 * escalates to signals (see {@link stopStaleDaemon}), so it would kill the
 * agent host itself rather than a detached child.
 *
 * An embedded daemon is a supported arrangement — `runDaemon` is exported and
 * a host may run one in-process (the OpenClaw plugin's pairing tests do), in
 * which case the pidfile carries the HOST's pid. Compares both the pid the
 * daemon reports over the control socket and the one in the pidfile, since
 * either alone can be missing.
 */
export function isSelfHostedDaemon(
  reportedPid: number | null | undefined,
  pidfilePid: number | null,
  selfPid: number,
): boolean {
  return reportedPid === selfPid || pidfilePid === selfPid;
}

/**
 * Grace period for a stale daemon to exit after `daemon.stop` before the
 * restart escalates to signals — a lingering daemon still owns the control
 * socket, which would make the freshly spawned replacement fail to bind.
 */
const STALE_DAEMON_STOP_TIMEOUT_MS = 8_000;

/**
 * Stop a stale daemon we manage: ask it to stop over the control socket, then
 * make sure the process is actually gone (escalating to signals) before the
 * caller spawns its replacement.
 */
async function stopStaleDaemon(opts: {
  env: NodeJS.ProcessEnv;
  pid: number | null;
  socketPath?: string;
}): Promise<void> {
  try {
    const clientOptions: ControlClientOptions = { timeoutMs: 1000 };
    if (opts.socketPath !== undefined) clientOptions.path = opts.socketPath;
    const client = await connectControl(clientOptions);
    try {
      await client.request('daemon.stop', {});
    } finally {
      client.close();
    }
  } catch {
    // Socket already gone or unresponsive — the signal path below is the
    // failsafe that guarantees the old process is not left holding the socket.
  }
  if (opts.pid !== null) {
    await stopDaemonProcess({
      env: opts.env,
      pid: opts.pid,
      force: true,
      timeoutMs: STALE_DAEMON_STOP_TIMEOUT_MS,
    });
  }
}

/**
 * Ensure a daemon is reachable over its control socket, auto-starting a
 * detached one when {@link daemonLiveness} reports it isn't running.
 *
 * This is the logic that used to live privately in `src/cli.ts`; it is
 * exported here so agent hosts (which are not the `ac2` CLI) can reuse it
 * instead of shelling out to the CLI or duplicating the spawn/poll loop.
 *
 * Liveness is decided by the control socket first: a daemon under OS
 * supervision writes no pidfile, and a pidfile-only check used to spawn a
 * redundant second daemon on top of a perfectly healthy supervised one.
 *
 * A reachable daemon is additionally checked for staleness: when it reports a
 * different version than this build ({@link isStaleDaemonVersion}) AND it is a
 * detached daemon THIS install manages (it wrote a pidfile), it is stopped and
 * replaced with a fresh one from the current build. This is what makes an
 * upgraded agent host (e.g. the OpenClaw plugin after `plugins update`) stop
 * silently talking to a service left running from the previous version instead
 * of requiring a manual `ac2 service stop`. An OS-supervised daemon (no
 * pidfile) is owned by its service unit and left for that upgrade path.
 *
 * The same restart applies when the running daemon uses a different runtime
 * adapter than this caller needs ({@link isRuntimeAdapterMismatch}) — the
 * adapter is fixed at startup, so reusing such a daemon leaves the wallet
 * paired to a service with no live agent behind it.
 */
export async function ensureDaemonRunning(options: EnsureDaemonRunningOptions = {}): Promise<void> {
  // Startup-failure reports are timestamped; only one written during THIS
  // attempt may fail it (a stale report from an earlier crash is ignored).
  const attemptStartedAt = Date.now();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 5000;
  const expectedVersion =
    options.expectedVersion === undefined ? AC2_DAEMON_VERSION : options.expectedVersion;
  const expectedRuntimeAdapter =
    options.expectedRuntimeAdapter === undefined
      ? (env['AC2_RUNTIME']?.trim() ?? '') || null
      : options.expectedRuntimeAdapter;
  const log = options.log ?? ((message: string) => console.log(message));

  const livenessOptions: DaemonLivenessOptions = { env, timeoutMs: 300 };
  if (options.socketPath !== undefined) livenessOptions.socketPath = options.socketPath;
  const liveness = await daemonLiveness(livenessOptions);

  let needSpawn: boolean;
  if (liveness.source === 'control-socket') {
    const runningVersion = liveness.status?.version;
    const runningAdapter = liveness.status?.runtimeAdapter;
    const reason = isStaleDaemonVersion(runningVersion, expectedVersion)
      ? `is running an older version (${runningVersion}, this build is ${String(expectedVersion)})`
      : isRuntimeAdapterMismatch(runningAdapter, expectedRuntimeAdapter)
        ? `is running the "${String(runningAdapter)}" runtime adapter, but this host needs ` +
          `"${String(expectedRuntimeAdapter)}" (the adapter is fixed when the service starts)`
        : null;
    if (reason === null) return;

    // Only auto-restart a daemon THIS install manages (a detached child writes
    // a pidfile). A daemon under OS supervision (launchd/systemd) writes none;
    // stopping it would just make the supervisor relaunch the same installed
    // binary, so leave it to the service-unit upgrade path and keep using it.
    const managedPid = await readDaemonPid({ env });
    if (isSelfHostedDaemon(liveness.status?.pid, managedPid, options.selfPid ?? process.pid)) {
      log(
        `[ac2] AC2 service ${reason} but is running INSIDE this process — restart the host ` +
          'to apply the change.',
      );
      return;
    }
    if (managedPid === null) {
      log(
        `[ac2] AC2 service ${reason} but is OS-supervised — restart its service unit ` +
          '(e.g. `ac2 service stop`) to pick up the change.',
      );
      return;
    }

    log(`[ac2] AC2 service ${reason} — restarting it to pick up the change…`);
    await stopStaleDaemon({
      env,
      pid: liveness.status?.pid ?? managedPid,
      ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
    });
    needSpawn = true;
  } else {
    // No live socket: spawn only when nothing is running at all. A pidfile that
    // is "running" but not yet answering is a daemon still binding — don't pile
    // a second one on top of it, just poll for it below.
    needSpawn = !liveness.running;
  }

  if (needSpawn) {
    await startDetached({
      command: process.execPath,
      args: [resolveOwnCliPath(), 'service', 'run'],
      env,
    });
  }

  const clientOptions: ControlClientOptions = { timeoutMs: 300 };
  if (options.socketPath !== undefined) clientOptions.path = options.socketPath;

  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const client = await connectControl(clientOptions);
      client.close();
      return;
    } catch (err) {
      lastError = err as Error;
      // A daemon that crashed during startup (e.g. the OS keychain is
      // unavailable on Linux without a Secret Service daemon) reports the
      // failure through a structured file (see `daemon/startup-report.ts`)
      // — its own log stays a human artifact the launcher never parses.
      // Fail fast with the reported cause instead of waiting out the timeout.
      const failure = await readStartupFailure(env);
      if (failure !== null && Date.parse(failure.timestamp) >= attemptStartedAt) {
        throw new Error(
          `[ac2] daemon (pid ${failure.pid}, version ${failure.version}) failed to start: ` +
            `${failure.message} — run \`ac2 service logs\` for the full log.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `[ac2] daemon did not become reachable within ${timeoutMs}ms: ` +
      `${lastError?.message ?? 'unknown error'} — run \`ac2 service logs\` for the daemon log.`,
  );
}

/** Maximum notifications buffered per event type while no listener is attached yet. */
const MAX_BUFFERED_EVENTS_PER_TYPE = 50;

/**
 * Fan out control-socket notifications to per-event listener sets, buffering
 * (bounded) events that arrive before the first listener for that event is
 * registered.
 *
 * WHY: `connectAgentSession` subscribes to events immediately on connect —
 * before `agent.hello` even resolves — so nothing is missed structurally.
 * But the caller can only call `session.on(...)` *after* `await
 * connectAgentSession(...)` returns, and a notification can arrive in that
 * gap. Buffering (and replaying once the first listener attaches) closes
 * that gap without requiring the caller to race the connection setup.
 */
function createEventHub(client: ControlClient) {
  const buffers = new Map<ControlEventName, unknown[]>();
  const handlers = new Map<ControlEventName, Set<(data: unknown) => void>>();

  function dispatch(event: ControlEventName, data: unknown): void {
    const set = handlers.get(event);
    if (set && set.size > 0) {
      for (const handler of [...set]) handler(data);
      return;
    }
    const buffered = buffers.get(event) ?? [];
    buffered.push(data);
    if (buffered.length > MAX_BUFFERED_EVENTS_PER_TYPE) buffered.shift();
    buffers.set(event, buffered);
  }

  for (const event of CONTROL_EVENTS) {
    client.on(event, (data) => dispatch(event, data));
  }

  return {
    on<E extends ControlEventName>(event: E, handler: ControlEventHandler<E>): void {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as (data: unknown) => void);
      // Replay whatever queued up before this first listener attached.
      const buffered = buffers.get(event);
      if (buffered && buffered.length > 0) {
        buffers.delete(event);
        for (const data of buffered) handler(data as never);
      }
    },
    off<E extends ControlEventName>(event: E, handler: ControlEventHandler<E>): void {
      handlers.get(event)?.delete(handler as (data: unknown) => void);
    },
  };
}

export interface AgentSessionOptions {
  /** Agent id to register (see `agent.hello`). Exactly one endpoint per id may be connected at a time. */
  agent: string;
  /** Human-readable host description, e.g. `openclaw@2026.7.1`. */
  host?: string;
  /** Auto-start the daemon if it isn't running (default `true`). */
  autoStart?: boolean;
  /** Control socket path; defaults to {@link resolveControlSocketPath}. */
  socketPath?: string;
  /** Connection/auto-start timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Events to subscribe to; defaults to every {@link CONTROL_EVENTS} entry. */
  events?: ControlEventName[];
}

/** A live, registered agent endpoint on the daemon control socket. */
export interface AgentSession {
  /** The underlying typed control-socket client (escape hatch for advanced use). */
  readonly client: ControlClient;
  /** Protocol version the daemon negotiated in `agent.hello`. */
  readonly protocolVersion: number;
  /** The daemon's own `did:key`, or `null` if it hasn't generated one yet. */
  readonly serviceDid: string | null;
  /** Wallet-issued identity already bootstrapped for this agent, if any. */
  readonly identity: AgentIdentitySummary | null;
  /** Wallet-connection snapshot as of `agent.hello`. */
  readonly connection: ConnectionSnapshot;
  /** Send an outbound frame to the connected wallet. Resolves `true` once delivered. */
  send(payload: string, channel?: 'control' | 'stream'): Promise<boolean>;
  /** Register a control-event listener (buffered — see {@link createEventHub}). */
  on<E extends ControlEventName>(event: E, handler: ControlEventHandler<E>): void;
  /** Remove a previously registered listener. */
  off<E extends ControlEventName>(event: E, handler: ControlEventHandler<E>): void;
  /** Start (or return the already-active) pairing cycle. */
  startPairing(opts?: {
    timeoutMs?: number;
  }): Promise<{ requestId: string; qrPayload: string; origin: string }>;
  /** Fetch a fresh `daemon.status` snapshot. */
  status(): Promise<DaemonStatus>;
  /** Unregister the agent and close the underlying socket. */
  close(): Promise<void>;
  /** Resolves once the underlying socket has fully closed. */
  closed: Promise<void>;
}

/**
 * Join the AC2 daemon as an agent endpoint, auto-starting it when needed.
 *
 * Replaces an agent host owning its own wallet connection: the daemon stays
 * the single source of truth for pairing/identity, and this call is all an
 * agent needs to talk to it.
 */
export async function connectAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
  const { agent } = options;
  const autoStart = options.autoStart ?? true;

  if (autoStart) {
    const ensureOptions: EnsureDaemonRunningOptions = {};
    if (options.socketPath !== undefined) ensureOptions.socketPath = options.socketPath;
    if (options.timeoutMs !== undefined) ensureOptions.timeoutMs = options.timeoutMs;
    await ensureDaemonRunning(ensureOptions);
  }

  const connectOptions: ControlClientOptions = {};
  if (options.socketPath !== undefined) connectOptions.path = options.socketPath;
  if (options.timeoutMs !== undefined) connectOptions.timeoutMs = options.timeoutMs;
  const client = await connectControl(connectOptions);

  // Subscribe (and start buffering) before `agent.hello` resolves, so events
  // fired the instant the agent registers are never lost.
  const hub = createEventHub(client);
  const subscribedEvents = options.events ?? [...CONTROL_EVENTS];

  try {
    await client.subscribe(subscribedEvents);

    const hello = await client.request('agent.hello', {
      agent,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      ...(options.host !== undefined ? { host: options.host } : {}),
    });

    return {
      client,
      protocolVersion: hello.protocolVersion,
      serviceDid: hello.serviceDid,
      identity: hello.identity,
      connection: hello.connection,
      async send(payload, channel = 'control') {
        const result = await client.request('agent.send', { agent, channel, payload });
        return result.delivered;
      },
      on: hub.on,
      off: hub.off,
      startPairing(opts) {
        return client.request('pair.start', opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});
      },
      status() {
        return client.request('daemon.status', {});
      },
      async close() {
        client.close();
        await client.closed;
      },
      closed: client.closed,
    };
  } catch (err) {
    client.close();
    if (err instanceof ControlRequestError && err.code === 'agent_taken') {
      throw new Error(
        `[ac2] agent id "${agent}" is already registered by another process; only one endpoint per ` +
          'agent id may be connected at a time. Close the other session (or wait for it to disconnect) ' +
          'before retrying.',
      );
    }
    throw err;
  }
}
