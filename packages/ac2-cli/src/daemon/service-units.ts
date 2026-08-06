/**
 * OS supervision units for the AC2 daemon.
 */

import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolveAc2Home } from '../control/protocol.js';

export interface SystemdOptions {
  execStart: string;
  description?: string;
  ac2Home?: string | undefined;
}

/**
 * Renders a systemd unit file for a user service.
 */
export function renderSystemdUnit(opts: SystemdOptions): string {
  const desc = opts.description ?? 'AC2 Connection Daemon';
  const homeEnv = opts.ac2Home ? `Environment=AC2_HOME=${opts.ac2Home}\n` : '';

  return [
    '[Unit]',
    `Description=${desc}`,
    'Documentation=https://github.com/algorandfoundation/ac2',
    '',
    '[Service]',
    `ExecStart=${opts.execStart}`,
    'Restart=on-failure',
    'RestartSec=5',
    homeEnv.trim(),
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
  const env = opts.ac2Home
    ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>AC2_HOME</key>
    <string>${escapeXml(opts.ac2Home)}</string>
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
}): Promise<{ kind: string; path: string; instructions: string[] }> {
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

  if (target.kind === 'systemd') {
    content = renderSystemdUnit({
      execStart: opts.execStart.join(' '),
      ac2Home: env?.AC2_HOME,
    });
    instructions = [
      'systemctl --user daemon-reload',
      'systemctl --user enable --now ac2',
    ];
  } else {
    // launchd
    const logFile = join(resolveAc2Home(env), 'ac2d.log');
    content = renderLaunchdPlist({
      programArguments: opts.execStart,
      logFile,
      ac2Home: env?.AC2_HOME,
    });
    instructions = [`launchctl load ${target.path}`];
  }

  await writeFile(target.path, content, 'utf8');
  return { kind: target.kind, path: target.path, instructions };
}

/**
 * Uninstalls the service unit.
 */
export async function uninstallServiceUnit(opts: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): Promise<{ removed: boolean; path: string | null }> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const target = resolveServiceUnitTarget(platform, env, homeDir);

  if (target.kind === 'unsupported') {
    return { removed: false, path: null };
  }

  try {
    await unlink(target.path);
    return { removed: true, path: target.path };
  } catch {
    return { removed: false, path: target.path };
  }
}
