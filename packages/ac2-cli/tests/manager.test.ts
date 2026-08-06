/**
 * Tests for the AC2 daemon manager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
