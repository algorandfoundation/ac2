#!/usr/bin/env node
/**
 * `ac2` command line: manages the AC2 daemon (background service or OS
 * supervision unit) and drives wallet pairing / connection inspection over
 * the control socket. See `src/daemon/run.ts` for the daemon runtime itself.
 */

import { fileURLToPath } from 'node:url';
import { connectControl } from './control/client.js';
import { ensureDaemonRunning } from './control/agent.js';
import { resolveControlSocketPath } from './control/protocol.js';
import type { DaemonStatus } from './control/protocol.js';
import {
  followLogFile,
  isProcessAlive,
  startDetached,
  stopDaemonProcess,
  tailLogFile,
} from './daemon/manager.js';
import { daemonLiveness } from './daemon/liveness.js';
import { installServiceUnit, uninstallServiceUnit } from './daemon/service-units.js';
import { runDaemon } from './daemon/run.js';
import { clearStartupFailure, reportStartupFailure } from './daemon/startup-report.js';
import { parseCliArgs, type CliFlags } from './cli-args.js';
import { isDirectInvocation } from './cli-entry.js';

const HELP_TEXT = `Usage: ac2 <command> [options]

Commands:
  service start [--foreground] [--origin <url>] [--agent <id>] [--auto-pair]
      Start the daemon (detached by default; --foreground blocks).
  service stop
      Stop the running daemon.
  service status
      Show daemon + connection status (exit 1 when not running).
  service attach
      Tail the daemon log, then follow it until Ctrl+C (does not stop the daemon).
  service logs [-n <lines>]
      Print the last N log lines (default 50).
  service install [--origin <url>] [--agent <id>]
      Install an OS supervision unit (systemd/launchd) for the daemon.
  service uninstall
      Remove the installed OS supervision unit.
  pair [--timeout <ms>]
      Ensure the daemon is running, then render a pairing QR and wait for a wallet.
  status
      Alias of \`service status\`.
  connections
      List persisted wallet connections.
  forget [--all | --id <requestId>]
      Forget a persisted connection (or everything, including agent identities).

  -h, --help
      Show this help.
`;

function printHelp(): void {
  console.log(HELP_TEXT);
}

/**
 * How long `service stop` waits for the daemon process to actually exit after
 * it acknowledged `daemon.stop`, before escalating to signals. Covers the
 * daemon's own graceful-stop failsafe (5s, see `run.ts`) with margin.
 */
const DAEMON_STOP_GRACE_MS = 8_000;

/** Poll `pid` until it exits (true) or `timeoutMs` elapses (false). */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !isProcessAlive(pid);
}

/** The `ac2` script's own path, used to spawn/reference itself (detached child, OS units). */
function ownCliPath(): string {
  return fileURLToPath(import.meta.url);
}

function serviceRunOptions(flags: CliFlags): {
  handleSignals: true;
  autoPair: boolean;
  origin?: string;
  defaultAgent?: string;
} {
  return {
    handleSignals: true,
    autoPair: flags.autoPair ?? false,
    ...(flags.origin !== undefined ? { origin: flags.origin } : {}),
    ...(flags.agent !== undefined ? { defaultAgent: flags.agent } : {}),
  };
}

/** Hidden `service run`: the foreground daemon body, used by the detached child + OS units. */
async function serviceRun(flags: CliFlags): Promise<number> {
  // Without this the daemon shows up as a bare `node` in `ps`/Activity Monitor,
  // which is exactly the anonymity the launchd launcher bundle exists to avoid.
  try {
    process.title = 'ac2d';
  } catch {
    // Setting the process title is cosmetic; never fail the daemon over it.
  }
  // A detached daemon has no channel back to its launcher, so a startup
  // failure is handed over as a structured report (and a successful start
  // clears any leftover) — see `daemon/startup-report.ts`. The launcher
  // (`ensureDaemonRunning`) reads the report instead of parsing the log.
  //
  // The catch on `runDaemon` below only sees failures of the awaited startup
  // path. A floating promise that rejects mid-startup (Node kills the process
  // on unhandled rejections) or a synchronous crash would bypass it and leave
  // the launcher with nothing but a timeout — report those too, then die with
  // the same non-zero exit Node's default behavior produces.
  for (const fatal of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(fatal, (err: unknown) => {
      void reportStartupFailure(err).finally(() => {
        console.error(err);
        process.exit(1);
      });
    });
  }
  const daemon = await runDaemon(serviceRunOptions(flags)).catch(async (err: unknown) => {
    await reportStartupFailure(err);
    throw err;
  });
  await clearStartupFailure();
  await daemon.closed;
  return 0;
}

function detachedArgs(flags: CliFlags): string[] {
  const args = ['service', 'run'];
  if (flags.origin !== undefined) args.push('--origin', flags.origin);
  if (flags.agent !== undefined) args.push('--agent', flags.agent);
  if (flags.autoPair) args.push('--auto-pair');
  return args;
}

async function serviceStart(flags: CliFlags): Promise<number> {
  if (flags.foreground) {
    const daemon = await runDaemon(serviceRunOptions(flags));
    console.log(`ac2 daemon listening on ${daemon.socketPath} (pid ${process.pid})`);
    await daemon.closed;
    return 0;
  }
  // An OS-supervised daemon writes no pidfile, so `startDetached`'s own check
  // would not see it and would spawn a second daemon that just fails to bind.
  const liveness = await daemonLiveness();
  if (liveness.running) {
    console.log(`daemon is already running (pid ${liveness.pid})`);
    console.log(`socket: ${resolveControlSocketPath()}`);
    return 0;
  }
  try {
    const { pid } = await startDetached({
      command: process.execPath,
      args: [ownCliPath(), ...detachedArgs(flags)],
    });
    console.log(`ac2 daemon started (pid ${pid})`);
    console.log(`socket: ${resolveControlSocketPath()}`);
    return 0;
  } catch (err) {
    console.error(`failed to start daemon: ${(err as Error).message}`);
    return 1;
  }
}

async function serviceStop(): Promise<number> {
  // Resolve WHO to stop first: the control socket also yields the pid of an
  // OS-supervised daemon (which writes no pidfile), so the signal escalation
  // below can target it when the graceful path stalls.
  const liveness = await daemonLiveness();
  if (!liveness.running) {
    console.log('daemon is not running');
    return 1;
  }
  const pid = liveness.pid;
  if (liveness.source === 'control-socket') {
    try {
      const client = await connectControl({ timeoutMs: 1000 });
      try {
        await client.request('daemon.stop', {});
      } finally {
        client.close();
      }
      // `daemon.stop` only acknowledges that a stop has begun — never report
      // success until the process is actually gone. A daemon wedged in
      // teardown (or one predating the explicit post-stop exit) acknowledges
      // and then lingers forever, which is exactly the "still active after a
      // reinstall, had to kill it by hand" trap.
      if (pid !== null && (await waitForProcessExit(pid, DAEMON_STOP_GRACE_MS))) {
        console.log(`daemon stopped (pid ${pid})`);
        return 0;
      }
      if (pid === null) {
        // No pid to verify or signal (a daemon.status without one) — the
        // request went through; nothing further can be checked.
        console.log('daemon stop requested');
        return 0;
      }
      console.log(`daemon did not exit after stop request; escalating to signals (pid ${pid})`);
    } catch {
      // The socket died between the liveness probe and the request — fall
      // through to the signal path.
    }
  }
  const result = await stopDaemonProcess({ ...(pid !== null ? { pid } : {}), force: true });
  if (result.stopped) {
    console.log(`daemon stopped (pid ${result.pid})`);
    return 0;
  }
  if (result.pid !== null) {
    console.error(`failed to stop daemon (pid ${result.pid}) — even SIGKILL did not take`);
    return 1;
  }
  console.log('daemon is not running');
  return 1;
}

function formatStatusLines(status: DaemonStatus): string[] {
  const uptimeSeconds = Math.max(
    0,
    Math.round((Date.now() - new Date(status.startedAt).getTime()) / 1000),
  );
  const wallet = status.connection.walletAddress
    ? ` (wallet: ${status.connection.walletAddress})`
    : '';
  const connectionState = status.waitingForRuntime
    ? `${status.connection.state} (waiting for a runtime before awaiting a wallet)`
    : status.connection.state;
  return [
    `pid: ${status.pid}`,
    `uptime: ${uptimeSeconds}s`,
    `service DID: ${status.serviceDid ?? '(none)'}`,
    `keystore socket: ${status.keystoreSocket ?? '(not hosted)'}`,
    `connection: ${connectionState}${wallet}`,
    `pairing: ${status.pairing ? status.pairing.requestId : '(none armed)'}`,
    `default agent: ${status.defaultAgent}`,
    `runtime adapter: ${status.runtimeAdapter ?? '(none)'}`,
    `agents: ${status.agents.length === 0 ? '(none)' : status.agents.map((a) => a.agent).join(', ')}`,
  ];
}

async function serviceStatus(): Promise<number> {
  // Liveness comes from the control socket first: a daemon under OS supervision
  // (launchd/systemd) writes no pidfile, and used to be reported as not running.
  const liveness = await daemonLiveness();
  if (!liveness.running) {
    console.log('daemon is not running');
    return 1;
  }
  console.log(`daemon is running (pid ${liveness.pid})`);
  if (liveness.status) {
    for (const line of formatStatusLines(liveness.status)) console.log(line);
  } else {
    console.log(`(control socket unreachable: ${liveness.socketError ?? 'unknown error'})`);
  }
  return 0;
}

async function serviceAttach(): Promise<number> {
  const lines = await tailLogFile({ lines: 20 });
  for (const line of lines) console.log(line);
  console.log('(attached — press Ctrl+C to detach; the daemon keeps running)');

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    await followLogFile({ onLine: (line) => console.log(line), signal: controller.signal });
  } finally {
    process.off('SIGINT', onSigint);
  }
  console.log('detached (daemon still running)');
  return 0;
}

async function serviceLogs(flags: CliFlags): Promise<number> {
  const lines = await tailLogFile({ lines: flags.lines ?? 50 });
  for (const line of lines) console.log(line);
  return 0;
}

async function serviceInstall(flags: CliFlags): Promise<number> {
  const execStart = [process.execPath, ownCliPath(), 'service', 'run'];
  if (flags.origin !== undefined) execStart.push('--origin', flags.origin);
  if (flags.agent !== undefined) execStart.push('--agent', flags.agent);
  try {
    const result = await installServiceUnit({ execStart });
    console.log(`installed ${result.kind} unit at ${result.path}`);
    // The unit is the daemon's whole environment, so show what was captured —
    // anything not listed here reverts to its default in the supervised daemon.
    const forwarded = Object.keys(result.environment);
    console.log(
      forwarded.length === 0
        ? 'environment: none captured (the daemon will use every default)'
        : `environment captured: ${forwarded.join(', ')}`,
    );
    if (result.launcher) {
      // Explain the extra artifact before the user finds it in their AC2 home,
      // and why it exists: macOS names the background item after this program.
      console.log(
        `launcher: ${result.launcher.bundlePath}${result.launcher.signed ? ' (ad-hoc signed)' : ''}`,
      );
      console.log('macOS will list this background item as "AC2"');
    }
    for (const instruction of result.instructions) console.log(`  ${instruction}`);
    return 0;
  } catch (err) {
    console.error(`failed to install service unit: ${(err as Error).message}`);
    return 1;
  }
}

async function serviceUninstall(): Promise<number> {
  const result = await uninstallServiceUnit();
  if (result.launcherPath !== undefined) console.log(`removed ${result.launcherPath}`);
  if (result.removed) {
    console.log(`removed ${result.path}`);
    return 0;
  }
  console.log('no service unit installed');
  return 1;
}

/** Render a pairing invitation as a scannable QR plus its raw payload. */
async function printInvitation(pairing: {
  requestId: string;
  qrPayload: string;
  origin: string;
}): Promise<void> {
  // The Liquid Auth provider no longer renders to a terminal (it lives in
  // the SDK, which must not depend on a TTY) — render the QR here instead.
  const qrcode = (await import('qrcode-terminal')).default;
  qrcode.generate(pairing.qrPayload, { small: true });
  console.log(pairing.qrPayload);
  console.log(`requestId: ${pairing.requestId}`);
  console.log(`origin: ${pairing.origin}`);
}

async function cmdPair(flags: CliFlags): Promise<number> {
  await ensureDaemonRunning();
  const client = await connectControl({ timeoutMs: 3000 });
  try {
    await client.subscribe();

    // A wallet may ALREADY be linked (the daemon resumes a persisted pairing on
    // start). `connection.connected` fired before this process existed, so
    // waiting for it below would hang forever — report the live session (with
    // the still-armed invitation, so a second scan is possible) and exit.
    const status = await client.request('daemon.status', {});
    if (status.connection.state === 'connected') {
      console.log(
        `already connected! wallet: ${status.connection.walletAddress ?? '(unknown)'}`,
      );
      if (status.connection.controllerDid) {
        console.log(`controller: ${status.connection.controllerDid}`);
      }
      if (status.pairing) await printInvitation(status.pairing);
      return 0;
    }

    const pairing = await client.request(
      'pair.start',
      flags.timeout !== undefined ? { timeoutMs: flags.timeout } : {},
    );
    await printInvitation(pairing);
    console.log('waiting for the wallet to connect… (Ctrl+C to cancel)');

    return await new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        client.off('connection.connected', onConnected);
        process.off('SIGINT', onSigint);
        resolve(code);
      };
      const onConnected = (data: { walletAddress: string | null }): void => {
        console.log(`connected! wallet: ${data.walletAddress ?? '(unknown)'}`);
        finish(0);
      };
      const onSigint = (): void => {
        console.log('cancelled');
        finish(1);
      };
      client.on('connection.connected', onConnected);
      process.once('SIGINT', onSigint);
    });
  } finally {
    client.close();
  }
}

async function cmdConnections(): Promise<number> {
  const client = await connectControl({ timeoutMs: 3000 });
  try {
    const { connections } = await client.request('connections.list', {});
    if (connections.length === 0) {
      console.log('no connections');
      return 0;
    }
    for (const c of connections) {
      console.log(
        `${c.requestId}  controller=${c.controllerDid ?? '-'}  agent=${c.agentDid ?? '-'}  ` +
          `conversations=${c.conversationCount}  lastActive=${c.lastActiveAt}`,
      );
    }
    return 0;
  } finally {
    client.close();
  }
}

async function cmdForget(flags: CliFlags): Promise<number> {
  if (!flags.all && !flags.id) {
    console.error('forget requires --all or --id <requestId>');
    return 1;
  }
  const client = await connectControl({ timeoutMs: 3000 });
  try {
    const params: { requestId?: string; all?: boolean } = flags.all
      ? { all: true }
      : { requestId: flags.id as string };
    const { forgotten } = await client.request('connections.forget', params);
    console.log(`forgot: ${forgotten.join(', ')}`);
    return 0;
  } finally {
    client.close();
  }
}

/** Dispatch a parsed command; returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    printHelp();
    return 1;
  }
  const { command, flags } = parsed;

  if (flags.help) {
    printHelp();
    return 0;
  }
  if (command.length === 0) {
    printHelp();
    return 1;
  }

  const [first, second] = command;
  try {
    if (first === 'service') {
      switch (second) {
        case 'start':
          return await serviceStart(flags);
        case 'run':
          return await serviceRun(flags);
        case 'stop':
          return await serviceStop();
        case 'status':
          return await serviceStatus();
        case 'attach':
          return await serviceAttach();
        case 'logs':
          return await serviceLogs(flags);
        case 'install':
          return await serviceInstall(flags);
        case 'uninstall':
          return await serviceUninstall();
        default:
          printHelp();
          return 1;
      }
    }
    if (first === 'pair') return await cmdPair(flags);
    if (first === 'status') return await serviceStatus();
    if (first === 'connections') return await cmdConnections();
    if (first === 'forget') return await cmdForget(flags);

    printHelp();
    return 1;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

if (isDirectInvocation(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
