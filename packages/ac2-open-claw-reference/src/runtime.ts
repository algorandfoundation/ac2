/** Shared runtime context: plugin ids, host `api` / `runtime`, config + log helpers. */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

export const PLUGIN_ID = 'ac2';
export const CHANNEL_ID = 'ac2';

/** Host API injected into `register(api)` (SDK `OpenClawPluginApi`). */
export type OpenClawApi = OpenClawPluginApi;

/** Effective plugin configuration (host config + env). */
export interface ResolvedConfig {
  liquidAuthServer?: string;
  defaultTimeoutMs?: number;
  x402MaxAmountAtomic?: string;
  x402AllowedNetworks?: string[];
  x402AllowedAssets?: string[];
  x402AllowedPayTo?: string[];
  x402NetworkPreferences?: string[];
  x402AlgodUrl?: string;
  x402AlgodToken?: string;
}

let activeApi: OpenClawApi | null = null;
let activeRuntime: any = null;

export function setActiveApi(api: OpenClawApi): void {
  activeApi = api;
}

export function getActiveApi(): OpenClawApi | null {
  return activeApi;
}

export function setActiveRuntime(runtime: any): void {
  activeRuntime = runtime;
}

export function getActiveRuntime(): any {
  return activeRuntime;
}

/**
 * Resolve effective config from `channels.<id>` + `plugins.entries.<id>.config`
 * + `api.pluginConfig`, then apply the `AC2_LIQUID_AUTH_SERVER` env override.
 *
 * `liquidAuthServer` is documented on the `channels.ac2` config surface (the
 * one `ac2 setup` writes and `ac2 status` reads), so it must be read from
 * there — not just from `plugins.entries.ac2.config` — otherwise the pairing
 * flow silently falls back to the default server and ignores the configured
 * URL. The `AC2_LIQUID_AUTH_SERVER` env var overrides it at runtime, matching
 * the channel runtime and the documented behaviour.
 */
export function resolveConfig(api: OpenClawApi): ResolvedConfig {
  const fromPluginConfig = (api.pluginConfig ?? {}) as ResolvedConfig;
  const cfg = api.config as unknown as
    | {
        plugins?: { entries?: Record<string, { config?: ResolvedConfig }> };
        channels?: Record<string, Partial<ResolvedConfig>>;
      }
    | undefined;
  const fromChannel = (cfg?.channels?.[CHANNEL_ID] ?? {}) as Partial<ResolvedConfig>;
  const fromConfig = cfg?.plugins?.entries?.[PLUGIN_ID]?.config ?? ({} as ResolvedConfig);
  const resolved: ResolvedConfig = { ...fromChannel, ...fromConfig, ...fromPluginConfig };

  const envServer =
    typeof process !== 'undefined' ? process.env?.['AC2_LIQUID_AUTH_SERVER']?.trim() : undefined;
  if (envServer) {
    resolved.liquidAuthServer = envServer;
  }

  return resolved;
}

/** Log through the host logger and the console (best-effort). */
export function safeLog(api: OpenClawApi, level: 'info' | 'warn' | 'error', msg: string): void {
  try {
    api.logger?.[level]?.(msg);
  } catch {
    // logger is best-effort
  }
  // eslint-disable-next-line no-console
  console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'](msg);
}

/** Wrap text in a `{ type: 'text' }` tool content block. */
export function textResult(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}
