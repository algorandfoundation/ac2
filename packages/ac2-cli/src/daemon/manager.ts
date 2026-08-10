/**
 * screen-like detached process manager for the AC2 daemon.
 */

import { spawn } from 'node:child_process';
import { mkdir, open, readFile, unlink, writeFile, stat } from 'node:fs/promises';
import { createReadStream, watch, watchFile, unwatchFile } from 'node:fs';
import { dirname } from 'node:path';
import {
  resolvePidFilePath,
  resolveLogFilePath,
} from '../control/protocol.js';

export interface DaemonManagerOptions {
  pidFile?: string;
  logFile?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Ensures the daemon process is running in the background.
 */
export async function startDetached(
  options: DaemonManagerOptions & { command: string; args: string[] }
): Promise<{ pid: number }> {
  const env = options.env ?? process.env;
  const pidFile = options.pidFile ?? resolvePidFilePath(env);
  const logFile = options.logFile ?? resolveLogFilePath(env);

  const status = await daemonProcessStatus(options);
  if (status.running) {
    throw new Error(`Daemon is already running (PID: ${status.pid})`);
  }

  const ac2Home = dirname(pidFile);
  await mkdir(ac2Home, { recursive: true, mode: 0o700 });

  const logFd = await open(logFile, 'a');
  const child = spawn(options.command, options.args, {
    detached: true,
    stdio: ['ignore', logFd.fd, logFd.fd],
    env,
    // Windows would otherwise flash (and keep) a console window for the daemon.
    windowsHide: true,
  });

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('Failed to spawn daemon process');
  }

  await writeFile(pidFile, `${pid}\n`, 'utf8');
  child.unref();
  await logFd.close();

  return { pid };
}

/**
 * Reads the PID from the pidfile.
 */
export async function readDaemonPid(options: DaemonManagerOptions = {}): Promise<number | null> {
  const env = options.env ?? process.env;
  const pidFile = options.pidFile ?? resolvePidFilePath(env);
  try {
    const content = await readFile(pidFile, 'utf8');
    const pid = parseInt(content.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Checks if a process with the given PID is alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

/**
 * Returns the status of the daemon process.
 */
export async function daemonProcessStatus(
  options: DaemonManagerOptions = {}
): Promise<{ running: boolean; pid: number | null; stale: boolean }> {
  const env = options.env ?? process.env;
  const pidFile = options.pidFile ?? resolvePidFilePath(env);
  const pid = await readDaemonPid(options);

  if (pid === null) {
    return { running: false, pid: null, stale: false };
  }

  if (isProcessAlive(pid)) {
    return { running: true, pid, stale: false };
  }

  // Stale pidfile
  try {
    await unlink(pidFile);
  } catch {
    // Ignore errors during cleanup
  }
  return { running: false, pid: null, stale: true };
}

/**
 * Stops the daemon process gracefully or forcefully.
 *
 * Targets `options.pid` when given — e.g. the pid the daemon itself reported
 * over the control socket, which is the only handle on an OS-supervised
 * daemon (it writes no pidfile) — and falls back to the pidfile otherwise.
 * An explicit pid that is already dead reports `stopped: true`: the caller
 * asked for a process it just observed alive to be gone, and it is.
 */
export async function stopDaemonProcess(
  options: DaemonManagerOptions & { timeoutMs?: number; force?: boolean; pid?: number } = {}
): Promise<{ stopped: boolean; pid: number | null }> {
  const env = options.env ?? process.env;
  const pidFile = options.pidFile ?? resolvePidFilePath(env);
  let pid: number;
  if (options.pid !== undefined) {
    if (!isProcessAlive(options.pid)) {
      return { stopped: true, pid: options.pid };
    }
    pid = options.pid;
  } else {
    const status = await daemonProcessStatus(options);
    if (!status.running || status.pid === null) {
      return { stopped: false, pid: null };
    }
    pid = status.pid;
  }

  const timeoutMs = options.timeoutMs ?? 10000;
  const force = options.force ?? false;

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err: any) {
    if (process.platform === 'win32') {
      try {
        process.kill(pid);
      } catch {
        // Fallback failed
      }
    }
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) {
      try {
        await unlink(pidFile);
      } catch {
        // Already gone
      }
      return { stopped: true, pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (force) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return { stopped: false, pid };
    }
    // SIGKILL cannot be caught, but delivery is asynchronous — poll briefly so
    // `stopped: true` reflects an observed death, not just a sent signal.
    const killDeadline = Date.now() + 2000;
    while (Date.now() < killDeadline && isProcessAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!isProcessAlive(pid)) {
      try {
        await unlink(pidFile);
      } catch {
        // No pidfile to clean up (explicit-pid target) or already gone.
      }
      return { stopped: true, pid };
    }
  }

  return { stopped: false, pid };
}

/**
 * Returns the last N lines of the log file.
 */
export async function tailLogFile(
  options: { logFile?: string; lines?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<string[]> {
  const env = options.env ?? process.env;
  const logFile = options.logFile ?? resolveLogFilePath(env);
  const maxLines = options.lines ?? 50;

  try {
    const fileStat = await stat(logFile);
    const size = fileStat.size;
    const bufferSize = Math.min(size, 64 * 1024); // 64KB chunk
    const fd = await open(logFile, 'r');
    const buffer = Buffer.alloc(bufferSize);

    const { bytesRead } = await fd.read(buffer, 0, bufferSize, size - bufferSize);
    await fd.close();

    const text = buffer.toString('utf8', 0, bytesRead);
    let lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (lines.length > maxLines) {
      return lines.slice(-maxLines);
    }
    return lines;
  } catch {
    return [];
  }
}

/**
 * Follows the log file similar to `tail -f`.
 */
export async function followLogFile(
  options: { logFile?: string; onLine(line: string): void; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
): Promise<void> {
  const env = options.env ?? process.env;
  const logFile = options.logFile ?? resolveLogFilePath(env);
  const { onLine, signal } = options;

  let currentSize = 0;
  try {
    currentSize = (await stat(logFile)).size;
  } catch {
    // File might not exist yet
  }

  const readFrom = async (start: number): Promise<number> => {
    try {
      const fileStat = await stat(logFile);
      const newSize = fileStat.size;
      if (newSize <= start) return start;

      const fd = await open(logFile, 'r');
      const buffer = Buffer.alloc(newSize - start);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, start);
      await fd.close();

      const text = buffer.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      // If the last line is empty (it ends with \n), don't treat it as a line.
      // But actually tail -f shows lines as they come.
      // Usually, we want to split by \n and for each complete line call onLine.
      // If the file doesn't end with \n, the last element is a partial line.
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (line !== undefined) onLine(line);
      }
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        onLine(lastLine);
      }

      return newSize;
    } catch {
      return start;
    }
  };

  if (signal?.aborted) return;

  const onChange = async (): Promise<void> => {
    currentSize = await readFrom(currentSize);
  };

  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(logFile, onChange);
    signal?.addEventListener('abort', () => watcher?.close(), { once: true });
  } catch {
    // Fallback to watchFile
    watchFile(logFile, { interval: 500 }, onChange);
    signal?.addEventListener('abort', () => unwatchFile(logFile, onChange), { once: true });
  }

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}
