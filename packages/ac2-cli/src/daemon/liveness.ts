/**
 * "Is a daemon running?" — resolved from the control socket first, the pidfile
 * second.
 *
 * The pidfile is written by {@link startDetached}, i.e. only for a daemon this
 * CLI spawned itself. A daemon under OS supervision (`ac2 service install` +
 * launchd/systemd) runs `service run` in the foreground and writes no pidfile
 * at all, so a pidfile-only check reported a perfectly healthy supervised
 * service as "daemon is not running" — and made `ensureDaemonRunning` spawn a
 * second daemon on top of it.
 *
 * The live control socket is the authoritative signal: whoever answers
 * `daemon.status` on it *is* the daemon, however it was started. The pidfile
 * remains the fallback for the window where a detached daemon has been spawned
 * but is not listening yet (or is wedged and cannot answer).
 */

import { connectControl, type ControlClient, type ControlClientOptions } from '../control/client.js';
import { resolveControlSocketPath, type DaemonStatus } from '../control/protocol.js';
import { daemonProcessStatus } from './manager.js';

/** How liveness was established. */
export type DaemonLivenessSource = 'control-socket' | 'pidfile' | 'none';

export interface DaemonLiveness {
  running: boolean;
  /** Pid reported by the daemon itself, else the pidfile's, else `null`. */
  pid: number | null;
  source: DaemonLivenessSource;
  /** Full snapshot, present only when the control socket answered. */
  status?: DaemonStatus;
  /** Why the control socket did not answer, when it did not. */
  socketError?: string;
}

export interface DaemonLivenessOptions {
  env?: NodeJS.ProcessEnv;
  /** Control socket path; defaults to the one derived from `env`. */
  socketPath?: string;
  /** Control socket connect/request timeout (default 1000ms). */
  timeoutMs?: number;
  /** Injectable for tests. */
  connect?: (options: ControlClientOptions) => Promise<ControlClient>;
  /** Injectable for tests. */
  processStatus?: typeof daemonProcessStatus;
}

/**
 * Probe the daemon, preferring the control socket over the pidfile.
 */
export async function daemonLiveness(
  options: DaemonLivenessOptions = {},
): Promise<DaemonLiveness> {
  const connect = options.connect ?? connectControl;
  const processStatus = options.processStatus ?? daemonProcessStatus;
  const clientOptions: ControlClientOptions = { timeoutMs: options.timeoutMs ?? 1000 };
  const socketPath =
    options.socketPath ??
    (options.env !== undefined ? resolveControlSocketPath(options.env) : undefined);
  if (socketPath !== undefined) clientOptions.path = socketPath;

  let socketError: string | undefined;
  try {
    const client = await connect(clientOptions);
    try {
      const status = await client.request('daemon.status', {});
      return { running: true, pid: status.pid, source: 'control-socket', status };
    } finally {
      client.close();
    }
  } catch (err) {
    socketError = (err as Error).message;
  }

  const error = socketError !== undefined ? { socketError } : {};
  const proc = await processStatus(options.env !== undefined ? { env: options.env } : {});
  if (proc.running) {
    return { running: true, pid: proc.pid, source: 'pidfile', ...error };
  }
  return { running: false, pid: null, source: 'none', ...error };
}
