/**
 * Tests for the AC2 service units.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
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
