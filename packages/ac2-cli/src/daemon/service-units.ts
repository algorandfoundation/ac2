/**
 * OS supervision units for the AC2 daemon.
 */

import { chmod, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolveAc2Home } from '../control/protocol.js';
import {
  removeDarwinAppBundle,
  writeDarwinAppBundle,
  type DarwinAppBundleResult,
} from './darwin-app-bundle.js';

/**
 * Environment variables carried from the installing shell into the supervision
 * unit.
 *
 * An OS-supervised daemon inherits **no** environment from the session that
 * installed it: launchd and systemd start it from the user's bare login
 * context. Forwarding only `AC2_HOME` (as earlier releases did) silently
 * dropped every other setting — most damagingly `AC2_STATE_DIR`, so a service
 * installed with a custom state directory came back up on the default
 * `~/.openclaw` after a restart, with a different keystore and no connections.
 *
 * Only variables that are actually set are written, so a plain install still
 * produces a unit with no `Environment=` / `EnvironmentVariables` at all.
 */
export const FORWARDED_ENV_VARS = [
  'AC2_HOME',
  'AC2_STATE_DIR',
  'AC2_DAEMON_SOCKET',
  'AC2_LIQUID_AUTH_SERVER',
  'AC2_DEFAULT_AGENT',
  'AC2_HEARTBEAT_TIMEOUT_MS',
  'AC2_KEYRING',
  'AC2_RUNTIME',
  'AC2_RUNTIME_CONFIG',
  'AC2_WAIT_FOR_RUNTIME',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH',
  'OPENCLAW_HOME',
  'OPENCLAW_GATEWAY_URL',
  'OPENCLAW_GATEWAY_PORT',
  'OPENCLAW_GATEWAY_TOKEN',
] as const;

/** Forwarded variables whose value is a secret, so callers can warn about them. */
export const SECRET_ENV_VARS: readonly string[] = ['OPENCLAW_GATEWAY_TOKEN', 'AC2_RUNTIME_CONFIG'];

/**
 * Picks the {@link FORWARDED_ENV_VARS} that are set (and non-blank) out of
 * `env`, preserving the declared order so unit files are stable.
 */
export function collectForwardedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_ENV_VARS) {
    const value = env[name];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    forwarded[name] = trimmed;
  }
  return forwarded;
}

/** Merges the legacy `ac2Home` shorthand into an explicit environment map. */
function unitEnvironment(opts: {
  environment?: Record<string, string> | undefined;
  ac2Home?: string | undefined;
}): Record<string, string> {
  const environment = { ...(opts.environment ?? {}) };
  if (opts.ac2Home && environment['AC2_HOME'] === undefined) environment['AC2_HOME'] = opts.ac2Home;
  return environment;
}

export interface SystemdOptions {
  execStart: string;
  description?: string;
  /** Environment forwarded to the daemon (see {@link collectForwardedEnv}). */
  environment?: Record<string, string> | undefined;
  /** Shorthand for `environment: { AC2_HOME }`, kept for compatibility. */
  ac2Home?: string | undefined;
}

/**
 * Quotes a systemd `Environment=` value. `%` is systemd's specifier prefix and
 * must be doubled; whitespace and quotes need the double-quoted form.
 */
function escapeSystemdEnvValue(value: string): string {
  const escaped = value.replace(/%/g, '%%');
  if (!/[\s"'\\]/.test(escaped)) return escaped;
  return `"${escaped.replace(/([\\"])/g, '\\$1')}"`;
}

/**
 * Renders a systemd unit file for a user service.
 */
export function renderSystemdUnit(opts: SystemdOptions): string {
  const desc = opts.description ?? 'AC2 Connection Daemon';
  const environment = unitEnvironment(opts);
  const envLines = Object.entries(environment).map(
    ([name, value]) => `Environment=${name}=${escapeSystemdEnvValue(value)}`,
  );

  return [
    '[Unit]',
    `Description=${desc}`,
    'Documentation=https://github.com/algorandfoundation/ac2',
    '',
    '[Service]',
    `ExecStart=${opts.execStart}`,
    'Restart=on-failure',
    'RestartSec=5',
    ...envLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].filter(line => line !== null).join('\n').replace(/\n\n+/g, '\n\n');
}

export interface LaunchdOptions {
  label?: string;
  programArguments: string[];
  logFile: string;
  /** Environment forwarded to the daemon (see {@link collectForwardedEnv}). */
  environment?: Record<string, string> | undefined;
  /** Shorthand for `environment: { AC2_HOME }`, kept for compatibility. */
  ac2Home?: string | undefined;
}

/**
 * Renders a launchd plist for a user agent.
 */
export function renderLaunchdPlist(opts: LaunchdOptions): string {
  const label = opts.label ?? 'com.algorandfoundation.ac2';
  const args = opts.programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');
  const environment = unitEnvironment(opts);
  const envEntries = Object.entries(environment)
    .map(([name, value]) => `    <key>${escapeXml(name)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join('\n');
  const env =
    envEntries.length > 0
      ? `
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>`
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.logFile)}</string>${env}
</dict>
</plist>
`;
}

function escapeXml(str: string): string {
  return str.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return c;
    }
  });
}

/**
 * Resolves the target path for the service unit based on the platform.
 */
export function resolveServiceUnitTarget(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir()
): { kind: 'systemd'; path: string } | { kind: 'launchd'; path: string } | { kind: 'unsupported' } {
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME || join(homeDir, '.config');
    return { kind: 'systemd', path: join(configHome, 'systemd', 'user', 'ac2.service') };
  }
  if (platform === 'darwin') {
    return { kind: 'launchd', path: join(homeDir, 'Library', 'LaunchAgents', 'com.algorandfoundation.ac2.plist') };
  }
  return { kind: 'unsupported' };
}

/**
 * Installs the service unit for OS supervision.
 */
export async function installServiceUnit(opts: {
  execStart: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  /**
   * Overrides how the macOS launcher bundle is code signed; `null` skips
   * signing. Injectable for tests, which must not shell out to `codesign`.
   */
  signBundle?: ((bundlePath: string) => Promise<void>) | null;
}): Promise<{
  kind: string;
  path: string;
  instructions: string[];
  /** The environment baked into the unit, for the caller to report back. */
  environment: Record<string, string>;
  /** The generated macOS launcher bundle, on darwin only. */
  launcher?: DarwinAppBundleResult;
}> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const target = resolveServiceUnitTarget(platform, env, homeDir);

  if (target.kind === 'unsupported') {
    // Windows has no user-level unit format the CLI can write; the detached
    // daemon (`ac2 service start`) is the supported way to run it there.
    throw new Error(
      `OS supervision is not supported on platform: ${platform}. ` +
        'Use `ac2 service start` to run the daemon detached instead.',
    );
  }

  await mkdir(dirname(target.path), { recursive: true });

  let content = '';
  let instructions: string[] = [];
  let launcher: DarwinAppBundleResult | undefined;

  const environment = collectForwardedEnv(env);

  if (target.kind === 'systemd') {
    content = renderSystemdUnit({
      execStart: opts.execStart.join(' '),
      environment,
    });
    instructions = [
      'systemctl --user daemon-reload',
      'systemctl --user enable --now ac2',
    ];
  } else {
    // launchd
    const ac2Home = resolveAc2Home(env);
    const logFile = join(ac2Home, 'ac2d.log');
    // macOS names the background item after the program the job launches, so the
    // job runs a launcher inside `AC2.app` rather than the bare `node` binary —
    // otherwise the user is asked to allow "node" to run in the background.
    await mkdir(ac2Home, { recursive: true });
    launcher = await writeDarwinAppBundle({
      dir: ac2Home,
      execStart: opts.execStart,
      ...(opts.signBundle !== undefined ? { sign: opts.signBundle } : {}),
    });
    content = renderLaunchdPlist({
      programArguments: [launcher.executablePath],
      logFile,
      environment,
    });
    instructions = [`launchctl load ${target.path}`];
  }

  // The unit carries the daemon's configuration verbatim, which can include a
  // gateway token, so it is never group/world readable. `writeFile`'s mode only
  // applies to a newly created file, hence the explicit chmod on rewrites.
  await writeFile(target.path, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(target.path, 0o600);
  return {
    kind: target.kind,
    path: target.path,
    instructions,
    environment,
    ...(launcher !== undefined ? { launcher } : {}),
  };
}

/**
 * Uninstalls the service unit.
 */
export async function uninstallServiceUnit(opts: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): Promise<{ removed: boolean; path: string | null; launcherPath?: string }> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const target = resolveServiceUnitTarget(platform, env, homeDir);

  if (target.kind === 'unsupported') {
    return { removed: false, path: null };
  }

  // The launcher bundle is an artifact of the install, so it goes away with it.
  let launcherPath: string | undefined;
  if (target.kind === 'launchd') {
    const launcher = await removeDarwinAppBundle(resolveAc2Home(env));
    if (launcher.removed) launcherPath = launcher.path;
  }

  const launcherResult = launcherPath !== undefined ? { launcherPath } : {};
  try {
    await unlink(target.path);
    return { removed: true, path: target.path, ...launcherResult };
  } catch {
    return { removed: false, path: target.path, ...launcherResult };
  }
}
