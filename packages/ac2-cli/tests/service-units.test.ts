/**
 * Tests for the AC2 service units.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectForwardedEnv,
  renderSystemdUnit,
  renderLaunchdPlist,
  resolveServiceUnitTarget,
  installServiceUnit,
  uninstallServiceUnit,
} from '../src/daemon/service-units.js';

describe('ServiceUnits', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ac2-service-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should render systemd unit correctly', () => {
    const unit = renderSystemdUnit({
      execStart: '/usr/bin/ac2 daemon run',
      ac2Home: '/home/user/.ac2',
    });
    expect(unit).toContain('ExecStart=/usr/bin/ac2 daemon run');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('Environment=AC2_HOME=/home/user/.ac2');
  });

  it('should render launchd plist correctly and escape XML', () => {
    const plist = renderLaunchdPlist({
      programArguments: ['/usr/local/bin/ac2', 'daemon', 'run', '--name', 'my & agent'],
      logFile: '/Users/user/.ac2/ac2d.log',
      ac2Home: '/Users/user/.ac2',
    });
    expect(plist).toContain('<string>/usr/local/bin/ac2</string>');
    expect(plist).toContain('<string>my &amp; agent</string>');
    expect(plist).toContain('<key>AC2_HOME</key>');
    expect(plist).toContain('<string>/Users/user/.ac2</string>');
  });

  it('should resolve service unit target per platform', () => {
    const linuxTarget = resolveServiceUnitTarget('linux', {}, '/home/user');
    expect(linuxTarget.kind).toBe('systemd');
    if (linuxTarget.kind === 'systemd') {
      expect(linuxTarget.path).toBe('/home/user/.config/systemd/user/ac2.service');
    }

    const darwinTarget = resolveServiceUnitTarget('darwin', {}, '/Users/user');
    expect(darwinTarget.kind).toBe('launchd');
    if (darwinTarget.kind === 'launchd') {
      expect(darwinTarget.path).toBe('/Users/user/Library/LaunchAgents/com.algorandfoundation.ac2.plist');
    }

    const winTarget = resolveServiceUnitTarget('win32');
    expect(winTarget.kind).toBe('unsupported');
  });

  it('should respect XDG_CONFIG_HOME on linux', () => {
    const env = { XDG_CONFIG_HOME: '/custom/config' };
    const target = resolveServiceUnitTarget('linux', env, '/home/user');
    if (target.kind === 'systemd') {
      expect(target.path).toBe('/custom/config/systemd/user/ac2.service');
    } else {
      throw new Error('Expected systemd target');
    }
  });

  it('should install and uninstall service unit', async () => {
    const env = { AC2_HOME: join(tmpDir, '.ac2') };
    const result = await installServiceUnit({
      execStart: ['/bin/ac2', 'run'],
      env,
      platform: 'linux',
      homeDir: tmpDir,
    });

    expect(result.kind).toBe('systemd');
    expect(result.path).toBe(join(tmpDir, '.config', 'systemd', 'user', 'ac2.service'));

    const content = await readFile(result.path, 'utf8');
    expect(content).toContain('ExecStart=/bin/ac2 run');

    const uninstallResult = await uninstallServiceUnit({
      platform: 'linux',
      env,
      homeDir: tmpDir,
    });
    expect(uninstallResult.removed).toBe(true);
  });
});

/**
 * A supervised daemon inherits nothing from the shell that installed it, so
 * everything it was configured with has to be written into the unit. Earlier
 * releases forwarded `AC2_HOME` only, which silently moved the state directory
 * (and therefore the keystore and connections) back to the default.
 */
describe('forwarded environment', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ac2-service-env-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('collects only the set, non-blank AC2/OpenClaw variables', () => {
    expect(
      collectForwardedEnv({
        AC2_HOME: '/srv/ac2',
        AC2_STATE_DIR: '  /srv/state  ',
        AC2_RUNTIME: 'openclaw-gateway',
        AC2_KEYRING: '   ',
        PATH: '/usr/bin',
        HOME: '/home/user',
      }),
    ).toEqual({
      AC2_HOME: '/srv/ac2',
      AC2_STATE_DIR: '/srv/state',
      AC2_RUNTIME: 'openclaw-gateway',
    });
  });

  it('keeps the declared order, so re-installing produces an identical unit', () => {
    const env = { AC2_RUNTIME: 'socket', AC2_STATE_DIR: '/srv/state', AC2_HOME: '/srv/ac2' };
    expect(Object.keys(collectForwardedEnv(env))).toEqual([
      'AC2_HOME',
      'AC2_STATE_DIR',
      'AC2_RUNTIME',
    ]);
  });

  it('writes every forwarded variable into the systemd unit', () => {
    const unit = renderSystemdUnit({
      execStart: '/usr/bin/node /opt/ac2/cli.js service run',
      environment: { AC2_HOME: '/srv/ac2', AC2_STATE_DIR: '/srv/state' },
    });
    expect(unit).toContain('Environment=AC2_HOME=/srv/ac2');
    expect(unit).toContain('Environment=AC2_STATE_DIR=/srv/state');
  });

  it('quotes systemd values that need it and doubles the specifier prefix', () => {
    const unit = renderSystemdUnit({
      execStart: '/usr/bin/ac2 run',
      environment: {
        AC2_STATE_DIR: '/srv/my state',
        AC2_RUNTIME_CONFIG: '{"url":"ws://127.0.0.1:18789"}',
        AC2_DEFAULT_AGENT: 'agent%1',
      },
    });
    expect(unit).toContain('Environment=AC2_STATE_DIR="/srv/my state"');
    // JSON needs the quoted form, with its own double quotes escaped.
    expect(unit).toContain(
      'Environment=AC2_RUNTIME_CONFIG="{\\"url\\":\\"ws://127.0.0.1:18789\\"}"',
    );
    expect(unit).toContain('Environment=AC2_DEFAULT_AGENT=agent%%1');
  });

  it('writes every forwarded variable into the launchd plist, escaped', () => {
    const plist = renderLaunchdPlist({
      programArguments: ['/usr/local/bin/node', '/opt/ac2/cli.js', 'service', 'run'],
      logFile: '/Users/user/.ac2/ac2d.log',
      environment: { AC2_HOME: '/Users/user/.ac2', AC2_STATE_DIR: '/Users/user/my & state' },
    });
    expect(plist).toContain('<key>AC2_HOME</key>');
    expect(plist).toContain('<key>AC2_STATE_DIR</key>');
    expect(plist).toContain('<string>/Users/user/my &amp; state</string>');
  });

  it('omits the environment block entirely when nothing is set', () => {
    expect(renderSystemdUnit({ execStart: '/usr/bin/ac2 run' })).not.toContain('Environment=');
    expect(
      renderLaunchdPlist({ programArguments: ['/usr/bin/ac2'], logFile: '/tmp/ac2d.log' }),
    ).not.toContain('EnvironmentVariables');
  });

  it('installs a systemd unit carrying AC2_STATE_DIR, with a private mode', async () => {
    const env = {
      AC2_HOME: join(tmpDir, '.ac2'),
      AC2_STATE_DIR: join(tmpDir, 'state'),
      AC2_RUNTIME: 'openclaw-gateway',
      OPENCLAW_GATEWAY_TOKEN: 's3cret',
    };
    const result = await installServiceUnit({
      execStart: ['/bin/node', '/opt/ac2/cli.js', 'service', 'run'],
      env,
      platform: 'linux',
      homeDir: tmpDir,
    });

    expect(result.environment).toEqual(env);
    const content = await readFile(result.path, 'utf8');
    expect(content).toContain(`Environment=AC2_STATE_DIR=${join(tmpDir, 'state')}`);
    expect(content).toContain('Environment=AC2_RUNTIME=openclaw-gateway');
    // The unit can hold a gateway token, so it must not be readable by others.
    const mode = (await stat(result.path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('installs a launchd plist carrying AC2_STATE_DIR', async () => {
    const env = { AC2_HOME: join(tmpDir, '.ac2'), AC2_STATE_DIR: join(tmpDir, 'state') };
    const result = await installServiceUnit({
      execStart: ['/usr/local/bin/node', '/opt/ac2/cli.js', 'service', 'run'],
      env,
      platform: 'darwin',
      homeDir: tmpDir,
      signBundle: null,
    });

    expect(result.kind).toBe('launchd');
    const content = await readFile(result.path, 'utf8');
    expect(content).toContain('<key>AC2_STATE_DIR</key>');
    expect(content).toContain(`<string>${join(tmpDir, 'state')}</string>`);
  });
});
