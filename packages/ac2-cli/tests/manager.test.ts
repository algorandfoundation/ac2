/**
 * Tests for the AC2 daemon manager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  startDetached,
  daemonProcessStatus,
  stopDaemonProcess,
  readDaemonPid,
  isProcessAlive,
  tailLogFile,
  followLogFile,
} from '../src/daemon/manager.js';

describe('DaemonManager', () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ac2-manager-test-'));
    env = { ...process.env, AC2_HOME: tmpDir };
  });

  afterEach(async () => {
    // Attempt to stop any daemon started in tests
    try {
      await stopDaemonProcess({ env, force: true });
    } catch {
      // Best-effort cleanup
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should start a detached process and manage pidfile', async () => {
    const { pid } = await startDetached({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{}, 1000)'],
      env,
    });

    expect(pid).toBeGreaterThan(0);
    expect(isProcessAlive(pid)).toBe(true);

    const status = await daemonProcessStatus({ env });
    expect(status.running).toBe(true);
    expect(status.pid).toBe(pid);
    expect(status.stale).toBe(false);

    const stopResult = await stopDaemonProcess({ env, timeoutMs: 2000 });
    expect(stopResult.stopped).toBe(true);

    const statusAfter = await daemonProcessStatus({ env });
    expect(statusAfter.running).toBe(false);
    expect(isProcessAlive(pid)).toBe(false);
  });

  it('stops a daemon known only by an explicit pid (no pidfile)', async () => {
    const { pid } = await startDetached({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{}, 1000)'],
      env,
    });
    // Simulate an OS-supervised daemon: it writes no pidfile, so the pid must
    // come from the caller (e.g. the pid `daemon.status` reported over the
    // control socket).
    await rm(join(tmpDir, 'ac2d.pid'), { force: true });

    const result = await stopDaemonProcess({ env, pid, timeoutMs: 2000 });
    expect(result).toEqual({ stopped: true, pid });
    expect(isProcessAlive(pid)).toBe(false);
  });

  it('reports an explicit pid that is already dead as stopped', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid!;
    await new Promise((resolve) => child.once('exit', resolve));

    // The caller observed this pid alive moments ago and asked for it to be
    // gone — and it is: that is a successful stop, not "nothing running".
    expect(await stopDaemonProcess({ env, pid })).toEqual({ stopped: true, pid });
  });

  it('escalates to SIGKILL when the process ignores SIGTERM and force is set', async () => {
    const readyFile = join(tmpDir, 'sigterm-ignorer-ready');
    const { pid } = await startDetached({
      command: process.execPath,
      args: [
        '-e',
        `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(
          readyFile,
        )}, 'ready'); setInterval(()=>{}, 1000)`,
      ],
      env,
    });
    // Wait for the SIGTERM handler to be installed, so the graceful signal is
    // genuinely ignored rather than delivered before the process booted.
    const deadline = Date.now() + 5000;
    while (!existsSync(readyFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(readyFile)).toBe(true);

    const result = await stopDaemonProcess({ env, timeoutMs: 300, force: true });
    expect(result).toEqual({ stopped: true, pid });
    expect(isProcessAlive(pid)).toBe(false);
  });

  it('should detect stale pidfiles', async () => {
    const pidFile = join(tmpDir, 'ac2d.pid');
    // Write a bogus dead PID (unlikely to exist)
    await writeFile(pidFile, '999999\n');

    const status = await daemonProcessStatus({ env });
    expect(status.running).toBe(false);
    expect(status.stale).toBe(true);
    // Should have cleaned up the stale file
    expect(await readDaemonPid({ env })).toBeNull();
  });

  it('should tail log file', async () => {
    const logFile = join(tmpDir, 'ac2d.log');
    const lines = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(`line ${i}`);
    }
    await writeFile(logFile, lines.join('\n') + '\n');

    const lastLines = await tailLogFile({ logFile, lines: 10, env });
    // Split by \n might include an empty string at the end if the file ends with \n
    const filtered = lastLines.filter(Boolean);
    expect(filtered).toHaveLength(10);
    expect(filtered[filtered.length - 1]).toBe('line 100');
    expect(filtered[0]).toBe('line 91');
  });

  it('should follow log file', async () => {
    const logFile = join(tmpDir, 'ac2d.log');
    await writeFile(logFile, 'initial line\n');

    const lines: string[] = [];
    const controller = new AbortController();

    const followPromise = followLogFile({
      logFile,
      onLine: (line) => lines.push(line),
      signal: controller.signal,
      env,
    });

    // Wait a bit for watcher to start
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(logFile, 'new line\n');

    // Wait for event to propagate
    let iterations = 0;
    while (lines.indexOf('new line') === -1 && iterations < 10) {
      await new Promise((r) => setTimeout(r, 200));
      iterations++;
    }

    controller.abort();
    await followPromise;

    expect(lines).toContain('new line');
  });
});
