/**
 * Structured startup-failure handshake between the daemon and its launcher.
 *
 * A detached daemon has no channel back to the process that spawned it: its
 * stdio is redirected to the log file and the launcher only polls the control
 * socket. When startup fails (e.g. the OS keychain is unavailable on Linux
 * without a Secret Service daemon), the launcher used to see nothing but a
 * timeout — the cause lived only in the log, and scraping the log from the
 * launcher means parsing our own free-form output.
 *
 * Instead, the daemon reports a startup failure through a small, structured
 * JSON file next to its pidfile ({@link reportStartupFailure}), removes it
 * once it starts successfully ({@link clearStartupFailure}), and the launcher
 * reads it back ({@link readStartupFailure}). The report carries its own
 * timestamp so a launcher can tell a failure of THIS start attempt from a
 * stale leftover of an earlier one.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveAc2Home } from '../control/protocol.js';
import { AC2_DAEMON_VERSION } from './version.js';

/** Startup-failure report written by the daemon, read by its launcher. */
export interface StartupFailureReport {
  /** PID of the daemon process that failed to start. */
  pid: number;
  /** Package version of the daemon build that failed. */
  version: string;
  /** ISO-8601 time the failure was reported (freshness check for launchers). */
  timestamp: string;
  /** The startup error's message, verbatim. */
  message: string;
}

/** Where the daemon leaves its startup-failure report (next to the pidfile). */
export function resolveStartupErrorFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAc2Home(env), 'ac2d.startup-error.json');
}

/**
 * Record a startup failure for the launcher to find. Best-effort: the error
 * is also printed to stderr (→ the daemon log), so a failure to write the
 * report must never mask the original startup error.
 */
export async function reportStartupFailure(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const report: StartupFailureReport = {
    pid: process.pid,
    version: AC2_DAEMON_VERSION,
    timestamp: new Date().toISOString(),
    message: error instanceof Error ? error.message : String(error),
  };
  try {
    const path = resolveStartupErrorFilePath(env);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Diagnostics only — never let them replace the real startup error.
  }
}

/** Remove any startup-failure report; called once the daemon is actually up. */
export async function clearStartupFailure(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await unlink(resolveStartupErrorFilePath(env));
  } catch {
    // Missing file (the common case) or unreadable directory — nothing to clear.
  }
}

/**
 * Read the daemon's startup-failure report, if any. Returns `null` when the
 * file is missing, unreadable, or not a well-formed report (e.g. written by
 * an incompatible future version) — the launcher then falls back to its
 * generic timeout error.
 */
export async function readStartupFailure(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartupFailureReport | null> {
  try {
    const raw = await readFile(resolveStartupErrorFilePath(env), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StartupFailureReport>;
    if (typeof parsed.message !== 'string' || typeof parsed.timestamp !== 'string') return null;
    if (Number.isNaN(Date.parse(parsed.timestamp))) return null;
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
      timestamp: parsed.timestamp,
      message: parsed.message,
    };
  } catch {
    return null;
  }
}
