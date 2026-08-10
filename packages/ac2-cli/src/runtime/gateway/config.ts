/**
 * Config resolution for the `openclaw-gateway` runtime adapter. Mirrors the
 * precedence used elsewhere in the daemon (explicit config → env → default)
 * — see `resolveRuntimeAdapterSpec` in `daemon/run.ts` for the sibling
 * pattern at the daemon level. This module resolves the SAME kind of
 * precedence one level down, inside the adapter's own config object.
 *
 * As a LAST resort — after explicit config and env come back empty — the
 * token and URL are auto-discovered from OpenClaw's own config file
 * (`openclaw.json`, `gateway.auth.token` / `gateway.remote.token` /
 * `gateway.port`). This is what makes
 * the plugin's auto-started daemon "just work" against a token-guarded local
 * Gateway without the operator having to export `OPENCLAW_GATEWAY_TOKEN`
 * first: the daemon inherits the plugin's env, resolves the same
 * `openclaw.json` the plugin reads, and lifts the token from it. An operator
 * can still override everything via config/env because discovery is the
 * lowest-priority source.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolved, fully-defaulted configuration for the `openclaw-gateway` adapter. */
export interface OpenClawGatewayConfig {
  /** Gateway WebSocket URL, e.g. `ws://127.0.0.1:18789`. */
  url: string;
  /** Bearer token for `auth.token`; `undefined` for an unauthenticated local gateway. */
  token?: string;
  /** Target agent id passed as `agentId` to the `agent` RPC; `undefined` uses the host's default. */
  agentId?: string;
  /** Timeout for the initial Gateway connect handshake. */
  connectTimeoutMs: number;
  /** Timeout passed to `agent.wait` for a single run. */
  runTimeoutMs: number;
  /**
   * Maximum number of past messages to fetch (via `chat.history`) when
   * replaying a conversation to the wallet on (re)connect.
   */
  historyLimit: number;
  /**
   * Timeout passed to the `agent.wait` RPC when awaiting a `sessions_spawn`
   * child run in the background (see `watchSpawnedTask` in `adapter.ts`).
   * Generous by default — a delegated sub-agent task can run far longer than
   * a single foreground turn (see `runTimeoutMs`), and the wait happens
   * DETACHED from the wallet turn that spawned it, so a long default costs
   * nothing on the wallet's timeline.
   */
  taskTimeoutMs: number;
  /**
   * Maximum number of sessions to fetch (via `sessions.list`) when
   * advertising a controller's threads to the wallet on connect (see
   * `listControllerThreads` in `adapter.ts`).
   */
  conversationsLimit: number;
}

const DEFAULT_PORT = 18789;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_RUN_TIMEOUT_MS = 120000;
const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_TASK_TIMEOUT_MS = 900000;
const DEFAULT_CONVERSATIONS_LIMIT = 100;

/** `value` if it's a non-empty string, else `undefined`. */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `value` if it's a finite positive number, else `undefined`. */
function positiveNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Reads the raw contents of a file, returning `undefined` when it is absent.
 * Injected into {@link resolveGatewayConfig} so unit tests can drive discovery
 * from an in-memory `openclaw.json` without ever touching the real
 * `~/.openclaw` on the host running the suite.
 */
export type OpenClawConfigFileReader = (path: string) => string | undefined;

const defaultOpenClawConfigFileReader: OpenClawConfigFileReader = (path) => {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    // A missing file is the normal case for a daemon started outside OpenClaw;
    // any other error (permissions, etc.) is likewise non-fatal for discovery.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw err;
  }
};

/**
 * Resolve the active `openclaw.json` path from the environment, mirroring the
 * plugin's `resolveOpenClawConfigPath` (`setup/config.ts`) exactly so the
 * daemon reads the SAME file the plugin does:
 * `OPENCLAW_STATE_DIR` → `OPENCLAW_CONFIG_PATH` → `OPENCLAW_HOME` →
 * `~/.openclaw/openclaw.json`.
 */
export function resolveOpenClawConfigPath(env: NodeJS.ProcessEnv): string {
  const stateDir = env['OPENCLAW_STATE_DIR']?.trim();
  if (stateDir) return join(stateDir, 'openclaw.json');
  const configPath = env['OPENCLAW_CONFIG_PATH']?.trim();
  if (configPath) return configPath;
  const home = env['OPENCLAW_HOME']?.trim();
  if (home) return join(home, 'openclaw.json');
  return join(homedir(), '.openclaw', 'openclaw.json');
}

/** Navigate a dotted path through a parsed JSON object, `undefined` if absent. */
function getAtPath(config: unknown, dotPath: string): unknown {
  let cursor: unknown = config;
  for (const seg of dotPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/** Gateway settings lifted from `openclaw.json`, all optional. */
interface OpenClawGatewayDiscovery {
  token?: string;
  port?: number;
}

/**
 * Best-effort discovery of the local Gateway's connection settings from
 * `openclaw.json`. Reads `gateway.port` (to build the default loopback URL)
 * and the shared token.
 *
 * TOKEN MODES: `gateway.auth.mode` is read when present, but an ABSENT mode
 * still means token auth — that is the Gateway's own default (it generates a
 * token at startup when none is configured), and treating "no mode" as "no
 * token" made the daemon connect unauthenticated against a perfectly
 * token-guarded gateway, which costs it every operator scope. Only an
 * explicit non-token mode (e.g. `none`) suppresses the token: sending a stale
 * token to a gateway that no longer expects one is worse than sending none.
 *
 * `gateway.remote.token` is used as a fallback for the same reason the
 * OpenClaw CLI does: local setups configured for a remote gateway keep the
 * shared secret there. Never throws: a missing/invalid file simply yields an
 * empty result with a logged note.
 */
function discoverOpenClawGateway(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  readFile: OpenClawConfigFileReader,
): OpenClawGatewayDiscovery {
  const path = resolveOpenClawConfigPath(env);
  let raw: string | undefined;
  try {
    raw = readFile(path);
  } catch (err) {
    log(`[ac2][openclaw-gateway] could not read ${path} for discovery: ${(err as Error)?.message}`);
    return {};
  }
  if (raw === undefined) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(`[ac2][openclaw-gateway] ${path} is not valid JSON; skipping gateway discovery`);
    return {};
  }

  const result: OpenClawGatewayDiscovery = {};

  const port = getAtPath(parsed, 'gateway.port');
  if (typeof port === 'number' && Number.isInteger(port) && port > 0) {
    result.port = port;
  }

  const authMode = getAtPath(parsed, 'gateway.auth.mode');
  if (authMode === undefined || authMode === 'token') {
    const token =
      stringOrUndefined(getAtPath(parsed, 'gateway.auth.token')) ??
      stringOrUndefined(getAtPath(parsed, 'gateway.remote.token'));
    if (token !== undefined) result.token = token;
  }

  return result;
}

/**
 * Resolve the effective adapter config from the caller-supplied `config`
 * object (from `DaemonRunOptions.runtime.config` / `AC2_RUNTIME_CONFIG`), the
 * process environment, and — as a last resort — OpenClaw's `openclaw.json`
 * (see the module JSDoc). Never throws: anything malformed is ignored with
 * a logged note rather than blocking adapter construction — a broken config
 * value should degrade to a default, not take the daemon down.
 *
 * @param readOpenClawConfigFile injectable file reader for the `openclaw.json`
 *   discovery step (defaults to a real `fs` read); tests pass a fake so the
 *   suite never depends on the host's real `~/.openclaw`.
 */
export function resolveGatewayConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void = () => {},
  readOpenClawConfigFile: OpenClawConfigFileReader = defaultOpenClawConfigFileReader,
): OpenClawGatewayConfig {
  const configUrl = stringOrUndefined(config['url']);
  if (config['url'] !== undefined && configUrl === undefined) {
    log('[ac2][openclaw-gateway] config.url ignored: expected a non-empty string');
  }
  const envUrl = stringOrUndefined(env['OPENCLAW_GATEWAY_URL']);
  const envPort = stringOrUndefined(env['OPENCLAW_GATEWAY_PORT']);

  const configToken = stringOrUndefined(config['token']);
  if (config['token'] !== undefined && configToken === undefined) {
    log('[ac2][openclaw-gateway] config.token ignored: expected a non-empty string');
  }
  const envToken = stringOrUndefined(env['OPENCLAW_GATEWAY_TOKEN']);

  // Discovery from `openclaw.json` is the LOWEST-priority source for both the
  // token and the URL. Only read the file when at least one of them is still
  // unresolved by explicit config/env, so an operator who fully configured the
  // adapter never pays for (or is surprised by) a file read.
  const tokenResolvedBeforeDiscovery = configToken ?? envToken;
  const urlResolvedBeforeDiscovery = configUrl ?? envUrl ?? envPort;
  const discovery: OpenClawGatewayDiscovery =
    tokenResolvedBeforeDiscovery === undefined || urlResolvedBeforeDiscovery === undefined
      ? discoverOpenClawGateway(env, log, readOpenClawConfigFile)
      : {};

  const discoveredPort = discovery.port !== undefined ? String(discovery.port) : undefined;
  const port = envPort ?? discoveredPort ?? String(DEFAULT_PORT);
  const url = configUrl ?? envUrl ?? `ws://127.0.0.1:${port}`;
  if (
    configUrl === undefined &&
    envUrl === undefined &&
    envPort === undefined &&
    discoveredPort !== undefined
  ) {
    log(`[ac2][openclaw-gateway] using gateway port ${discoveredPort} discovered from openclaw.json`);
  }

  const token = configToken ?? envToken ?? discovery.token;
  if (tokenResolvedBeforeDiscovery === undefined && discovery.token !== undefined) {
    log('[ac2][openclaw-gateway] using gateway token discovered from openclaw.json (gateway.auth.token)');
  }

  const configAgentId = stringOrUndefined(config['agentId']);
  if (config['agentId'] !== undefined && configAgentId === undefined) {
    log('[ac2][openclaw-gateway] config.agentId ignored: expected a non-empty string');
  }
  const agentId = configAgentId;

  const configConnectTimeoutMs = positiveNumberOrUndefined(config['connectTimeoutMs']);
  if (config['connectTimeoutMs'] !== undefined && configConnectTimeoutMs === undefined) {
    log('[ac2][openclaw-gateway] config.connectTimeoutMs ignored: expected a positive number');
  }
  const connectTimeoutMs = configConnectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const configRunTimeoutMs = positiveNumberOrUndefined(config['runTimeoutMs']);
  if (config['runTimeoutMs'] !== undefined && configRunTimeoutMs === undefined) {
    log('[ac2][openclaw-gateway] config.runTimeoutMs ignored: expected a positive number');
  }
  const runTimeoutMs = configRunTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  const configHistoryLimit = positiveNumberOrUndefined(config['historyLimit']);
  if (config['historyLimit'] !== undefined && configHistoryLimit === undefined) {
    log('[ac2][openclaw-gateway] config.historyLimit ignored: expected a positive number');
  }
  const historyLimit = configHistoryLimit ?? DEFAULT_HISTORY_LIMIT;

  const configTaskTimeoutMs = positiveNumberOrUndefined(config['taskTimeoutMs']);
  if (config['taskTimeoutMs'] !== undefined && configTaskTimeoutMs === undefined) {
    log('[ac2][openclaw-gateway] config.taskTimeoutMs ignored: expected a positive number');
  }
  const taskTimeoutMs = configTaskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  const configConversationsLimit = positiveNumberOrUndefined(config['conversationsLimit']);
  if (config['conversationsLimit'] !== undefined && configConversationsLimit === undefined) {
    log('[ac2][openclaw-gateway] config.conversationsLimit ignored: expected a positive number');
  }
  const conversationsLimit = configConversationsLimit ?? DEFAULT_CONVERSATIONS_LIMIT;

  return {
    url,
    ...(token !== undefined ? { token } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    connectTimeoutMs,
    runTimeoutMs,
    historyLimit,
    taskTimeoutMs,
    conversationsLimit,
  };
}
