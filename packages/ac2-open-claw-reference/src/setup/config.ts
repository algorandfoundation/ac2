/**
 * Transport-free config surface for the `ac2` channel: `openclaw.json`
 * read/write helpers, channel env vars, and the `status` / `setup` actions
 * consumed by the setup entry.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PLUGIN_ID = 'ac2';
export const CHANNEL_ID = 'ac2';
export const DEFAULT_LIQUID_AUTH_SERVER = 'https://debug.liquidauth.com';

/** OpenClaw `channelEnvVars` declaration for `ac2`. */
export interface Ac2ChannelEnvVar {
  name: string;
  description: string;
  required: boolean;
}

export const AC2_CHANNEL_ENV_VARS: ReadonlyArray<Ac2ChannelEnvVar> = [
  {
    name: 'AC2_LIQUID_AUTH_SERVER',
    description:
      'Liquid Auth signaling server origin. Overrides the `liquidAuthServer` channel config at runtime. ' +
      `Defaults to ${DEFAULT_LIQUID_AUTH_SERVER} when neither is set.`,
    required: false,
  },
  {
    name: 'AC2_SIGNAL_DEAD_TIMEOUT_MS',
    description:
      'Cumulative milliseconds the signaling socket may be offline (across all disconnect/reconnect cycles) ' +
      'during pairing before the current attempt is recycled. Defaults to 45000. Lower it to reproduce ' +
      'dead-socket/flapping recovery quickly in testing.',
    required: false,
  },
  {
    name: 'AC2_SIGNAL_HEALTH_POLL_MS',
    description:
      'How often the pairing health watchdog re-samples wall-clock time and socket state, in milliseconds. ' +
      'Defaults to 10000.',
    required: false,
  },
  {
    name: 'AC2_SIGNAL_SUSPEND_GAP_MS',
    description:
      'Wall-clock gap between watchdog ticks, in milliseconds, that is treated as a process freeze ' +
      '(laptop suspend/resume, container pause) and triggers a socket recycle. Defaults to 60000. ' +
      'Lower it to reproduce suspend/resume recovery quickly in testing.',
    required: false,
  },
];

/** Resolve the active `openclaw.json` path. */
export function resolveOpenClawConfigPath(): string {
  const stateDirEnv = process.env['OPENCLAW_STATE_DIR']?.trim();
  if (stateDirEnv) return join(stateDirEnv, 'openclaw.json');
  const configPathEnv = process.env['OPENCLAW_CONFIG_PATH']?.trim();
  if (configPathEnv) return configPathEnv;
  const homeEnv = process.env['OPENCLAW_HOME']?.trim();
  if (homeEnv) return join(homeEnv, 'openclaw.json');
  return join(homedir(), '.openclaw', 'openclaw.json');
}

export function getAtPath(config: any, dotPath: string): any {
  let cursor = config;
  for (const seg of dotPath.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = cursor[seg as string];
  }
  return cursor;
}

export function setAtPath(config: any, dotPath: string, value: any): void {
  const segments = dotPath.split('.');
  let cursor = config;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
    const existing = cursor[seg];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      cursor[seg] = {};
    }
    cursor = cursor[seg];
  }
  cursor[segments[segments.length - 1] as string] = value;
}

function readOpenClawConfig(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
}

/** Readiness snapshot derived from `openclaw.json` + env. */
export interface Ac2ChannelStatus {
  channel: string;
  configPath: string;
  pluginAllowed: boolean;
  pluginEnabled: boolean;
  liquidAuthServer: string;
  liquidAuthServerSource: 'env' | 'config' | 'default';
  bound: boolean;
  /** True when the plugin is allow-listed, enabled and bound to an agent. */
  ready: boolean;
}

export function readChannelStatus(): Ac2ChannelStatus {
  const configPath = resolveOpenClawConfigPath();
  let config: any = {};
  try {
    config = readOpenClawConfig(configPath);
  } catch {
    config = {};
  }

  const allow = getAtPath(config, 'plugins.allow');
  const pluginAllowed = Array.isArray(allow) && allow.includes(PLUGIN_ID);
  const pluginEnabled = getAtPath(config, `plugins.entries.${PLUGIN_ID}.enabled`) === true;

  const envServer = process.env['AC2_LIQUID_AUTH_SERVER']?.trim();
  const configServer = getAtPath(config, `channels.${CHANNEL_ID}.liquidAuthServer`);
  let liquidAuthServer = DEFAULT_LIQUID_AUTH_SERVER;
  let liquidAuthServerSource: Ac2ChannelStatus['liquidAuthServerSource'] = 'default';
  if (envServer) {
    liquidAuthServer = envServer;
    liquidAuthServerSource = 'env';
  } else if (typeof configServer === 'string' && configServer.length > 0) {
    liquidAuthServer = configServer;
    liquidAuthServerSource = 'config';
  }

  const bindings = getAtPath(config, 'bindings');
  const bound =
    Array.isArray(bindings) && bindings.some((b: any) => b?.match?.channel === CHANNEL_ID);

  return {
    channel: CHANNEL_ID,
    configPath,
    pluginAllowed,
    pluginEnabled,
    liquidAuthServer,
    liquidAuthServerSource,
    bound,
    ready: pluginAllowed && pluginEnabled && bound,
  };
}

/** Idempotent `ac2 setup`: allow-list + enable + default server + bind + tool grants. */
export function cmdSetup(): string {
  const out = ['AC2 plugin setup — applying OpenClaw config:'];
  let changes = 0;
  const path = resolveOpenClawConfigPath();
  let config: any;

  try {
    config = readOpenClawConfig(path);
  } catch (err: any) {
    return `Failed to read OpenClaw config: ${err.message}`;
  }

  out.push(`  Config: ${path}`);

  // 1. plugins.allow — append PLUGIN_ID if missing
  {
    const existing = getAtPath(config, 'plugins.allow') ?? [];
    if (Array.isArray(existing) && !existing.includes(PLUGIN_ID)) {
      setAtPath(config, 'plugins.allow', [...new Set([...existing, PLUGIN_ID])]);
      out.push(`  ✓ plugins.allow += "${PLUGIN_ID}"`);
      changes++;
    }
  }

  // 2. plugins.entries.<id>.enabled = true
  {
    const enabled = getAtPath(config, `plugins.entries.${PLUGIN_ID}.enabled`);
    if (enabled !== true) {
      setAtPath(config, `plugins.entries.${PLUGIN_ID}.enabled`, true);
      out.push(`  ✓ plugins.entries.${PLUGIN_ID}.enabled = true`);
      changes++;
    }
  }

  // 3. channels.ac2.liquidAuthServer
  {
    const server = getAtPath(config, `channels.${CHANNEL_ID}.liquidAuthServer`);
    if (!server) {
      setAtPath(config, `channels.${CHANNEL_ID}.liquidAuthServer`, DEFAULT_LIQUID_AUTH_SERVER);
      out.push(`  ✓ channels.${CHANNEL_ID}.liquidAuthServer set`);
      changes++;
    }
  }

  // 4. bindings — route main agent to ac2 channel
  {
    const existing = getAtPath(config, 'bindings') ?? [];
    if (Array.isArray(existing)) {
      const hasBinding = existing.some(
        (b: any) => b?.match?.channel === CHANNEL_ID && b?.agentId === 'main',
      );
      if (!hasBinding) {
        setAtPath(config, 'bindings', [
          ...existing,
          { agentId: 'main', match: { channel: CHANNEL_ID } },
        ]);
        out.push(`  ✓ bindings += main → "${CHANNEL_ID}"`);
        changes++;
      }
    }
  }

  // 5. tools.alsoAllow — permit ac2_* tools
  {
    const toolNames = ['ac2_sign', 'ac2_capabilities', 'ac2_x402_fetch'];
    const alsoAllow = getAtPath(config, 'tools.alsoAllow') ?? [];
    if (Array.isArray(alsoAllow)) {
      const missing = toolNames.filter((n) => !alsoAllow.includes(n));
      if (missing.length > 0) {
        setAtPath(config, 'tools.alsoAllow', [...new Set([...alsoAllow, ...toolNames])]);
        out.push(`  ✓ tools.alsoAllow += ${missing.join(', ')}`);
        changes++;
      }
    }
  }

  if (changes > 0) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
      out.push(
        '',
        `Done. ${changes} config change(s) written. Restart the gateway:`,
        '  openclaw gateway restart',
      );
    } catch (err: any) {
      return `Failed to write config: ${err.message}`;
    }
  } else {
    out.push('', 'All settings already in place — no changes needed.');
  }

  return out.join('\n');
}
