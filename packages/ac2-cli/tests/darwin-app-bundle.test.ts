/**
 * Tests for the macOS launcher bundle.
 *
 * The bug being pinned down: the launchd agent pointed `ProgramArguments[0]` at
 * the Node binary, so macOS Background Task Management asked the user to allow
 * **"node"** to run in the background instead of naming AC2. The job now runs a
 * launcher inside a generated `AC2.app`, whose `CFBundleName` macOS displays.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DARWIN_APP_BUNDLE_NAME,
  DARWIN_APP_EXECUTABLE_NAME,
  removeDarwinAppBundle,
  renderDarwinAppInfoPlist,
  renderDarwinLauncherScript,
  writeDarwinAppBundle,
} from '../src/daemon/darwin-app-bundle.js';
import { installServiceUnit, uninstallServiceUnit } from '../src/daemon/service-units.js';

const run = promisify(execFile);

describe('renderDarwinLauncherScript', () => {
  it('execs the command so launchd supervises the daemon, not a shell', () => {
    const script = renderDarwinLauncherScript([
      '/opt/homebrew/bin/node',
      '/opt/ac2/cli.js',
      'service',
      'run',
    ]);
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain(
      `exec '/opt/homebrew/bin/node' '/opt/ac2/cli.js' 'service' 'run' "$@"`,
    );
  });

  it('quotes paths with spaces and single quotes', () => {
    const script = renderDarwinLauncherScript(['/usr/bin/node', "/Users/o'brien/my ac2/cli.js"]);
    expect(script).toContain(`exec '/usr/bin/node' '/Users/o'\\''brien/my ac2/cli.js' "$@"`);
  });

  it('refuses an empty command', () => {
    expect(() => renderDarwinLauncherScript([])).toThrow(/must not be empty/);
  });
});

describe('renderDarwinAppInfoPlist', () => {
  it('names the bundle AC2 and keeps it out of the Dock', () => {
    const plist = renderDarwinAppInfoPlist();
    // This is the string macOS shows in Login Items & Extensions.
    expect(plist).toContain('<key>CFBundleName</key>\n  <string>AC2</string>');
    expect(plist).toContain('<key>CFBundleDisplayName</key>\n  <string>AC2</string>');
    expect(plist).toContain(`<string>${DARWIN_APP_EXECUTABLE_NAME}</string>`);
    expect(plist).toContain('<key>CFBundleIdentifier</key>\n  <string>com.algorandfoundation.ac2</string>');
    expect(plist).toContain('<key>LSBackgroundOnly</key>');
    expect(plist).toContain('<key>LSUIElement</key>');
  });
});

describe('writeDarwinAppBundle', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ac2-bundle-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates an executable launcher inside AC2.app', async () => {
    const result = await writeDarwinAppBundle({
      dir: tmpDir,
      execStart: ['/usr/bin/node', '/opt/ac2/cli.js', 'service', 'run'],
      sign: null,
    });

    expect(result.bundlePath).toBe(join(tmpDir, DARWIN_APP_BUNDLE_NAME));
    expect(result.executablePath).toBe(
      join(tmpDir, DARWIN_APP_BUNDLE_NAME, 'Contents', 'MacOS', DARWIN_APP_EXECUTABLE_NAME),
    );
    expect(result.signed).toBe(false);
    expect((await stat(result.executablePath)).mode & 0o777).toBe(0o700);
    const info = await readFile(join(result.bundlePath, 'Contents', 'Info.plist'), 'utf8');
    expect(info).toContain('<string>AC2</string>');
  });

  it('rewrites a stale bundle instead of layering onto it', async () => {
    await writeDarwinAppBundle({ dir: tmpDir, execStart: ['/old/node', 'old.js'], sign: null });
    const result = await writeDarwinAppBundle({
      dir: tmpDir,
      execStart: ['/new/node', 'new.js'],
      sign: null,
    });
    const script = await readFile(result.executablePath, 'utf8');
    expect(script).toContain(`'/new/node' 'new.js'`);
    expect(script).not.toContain('/old/node');
  });

  it('reports an unsigned bundle when codesign fails, rather than throwing', async () => {
    const result = await writeDarwinAppBundle({
      dir: tmpDir,
      execStart: ['/usr/bin/node', 'cli.js'],
      sign: async () => {
        throw new Error('codesign: not found');
      },
    });
    expect(result.signed).toBe(false);
  });

  it('the launcher actually runs the command it wraps', async () => {
    const result = await writeDarwinAppBundle({
      dir: tmpDir,
      execStart: ['/bin/echo', 'ac2 launcher works'],
      sign: null,
    });
    const { stdout } = await run(result.executablePath, []);
    expect(stdout.trim()).toBe('ac2 launcher works');
  });

  it('removes the bundle, and reports when there was none', async () => {
    await writeDarwinAppBundle({ dir: tmpDir, execStart: ['/bin/echo'], sign: null });
    await expect(removeDarwinAppBundle(tmpDir)).resolves.toMatchObject({ removed: true });
    await expect(removeDarwinAppBundle(tmpDir)).resolves.toMatchObject({ removed: false });
  });
});

describe('launchd unit uses the launcher', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ac2-launchd-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('points ProgramArguments at AC2.app, not at the node binary', async () => {
    const ac2Home = join(tmpDir, '.ac2');
    const result = await installServiceUnit({
      execStart: ['/opt/homebrew/bin/node', '/opt/ac2/cli.js', 'service', 'run'],
      env: { AC2_HOME: ac2Home },
      platform: 'darwin',
      homeDir: tmpDir,
      signBundle: null,
    });

    expect(result.launcher?.executablePath).toBe(
      join(ac2Home, DARWIN_APP_BUNDLE_NAME, 'Contents', 'MacOS', DARWIN_APP_EXECUTABLE_NAME),
    );
    const plist = await readFile(result.path, 'utf8');
    expect(plist).toContain(`<string>${result.launcher?.executablePath}</string>`);
    // The node binary must not be the job's program any more — that is what made
    // macOS call the background item "node".
    expect(plist).not.toContain('/opt/homebrew/bin/node');
    // …but the launcher still runs exactly that command.
    const script = await readFile(result.launcher!.executablePath, 'utf8');
    expect(script).toContain(`'/opt/homebrew/bin/node' '/opt/ac2/cli.js' 'service' 'run'`);
  });

  it('uninstall removes the generated launcher along with the plist', async () => {
    const ac2Home = join(tmpDir, '.ac2');
    const env = { AC2_HOME: ac2Home };
    const installed = await installServiceUnit({
      execStart: ['/usr/bin/node', '/opt/ac2/cli.js', 'service', 'run'],
      env,
      platform: 'darwin',
      homeDir: tmpDir,
      signBundle: null,
    });

    const removed = await uninstallServiceUnit({ env, platform: 'darwin', homeDir: tmpDir });
    expect(removed).toMatchObject({
      removed: true,
      path: installed.path,
      launcherPath: installed.launcher?.bundlePath,
    });
    await expect(stat(installed.launcher!.bundlePath)).rejects.toThrow();
  });

  it('systemd installs need no launcher', async () => {
    const result = await installServiceUnit({
      execStart: ['/usr/bin/node', '/opt/ac2/cli.js', 'service', 'run'],
      env: { AC2_HOME: join(tmpDir, '.ac2') },
      platform: 'linux',
      homeDir: tmpDir,
    });
    expect(result.launcher).toBeUndefined();
    const unit = await readFile(result.path, 'utf8');
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/ac2/cli.js service run');
  });
});
