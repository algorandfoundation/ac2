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
import { startDetached } from '../daemon/manager.js';
import { daemonLiveness } from '../daemon/liveness.js';
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
 */
export async function ensureDaemonRunning(options: EnsureDaemonRunningOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 5000;

  const liveness = await daemonLiveness({
    env,
    timeoutMs: 300,
    ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
  });
  if (liveness.source === 'control-socket') return;
  if (!liveness.running) {
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `[ac2] daemon did not become reachable within ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}`,
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
