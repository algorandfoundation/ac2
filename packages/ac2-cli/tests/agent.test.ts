/**
 * Tests for the reusable agent-session client (`src/control/agent.ts`):
 * `connectAgentSession` against a real in-process daemon, `ensureDaemonRunning`,
 * and the CLI entry-path resolver used to auto-start the daemon.
 *
 * Uses the in-memory channel provider (never invoked here — no pairing is
 * started) and a temp `AC2_STATE_DIR`/socket dir, so neither the network nor
 * the OS keychain is ever touched, and no real daemon process is spawned.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runDaemon, type RunningDaemon } from '../src/daemon/run.js';
import { InMemoryChannelProvider } from '@algorandfoundation/ac2-sdk/providers/in-memory';
import { connectControl, type ControlClient } from '../src/control/client.js';
import { createControlServer } from '../src/control/server.js';
import { CONTROL_PROTOCOL_VERSION } from '../src/control/protocol.js';
import {
  connectAgentSession,
  ensureDaemonRunning,
  isStaleDaemonVersion,
  resolveOwnCliPath,
  type AgentSession,
} from '../src/control/agent.js';
import { FALLBACK_DAEMON_VERSION } from '../src/daemon/version.js';
import { reportStartupFailure } from '../src/daemon/startup-report.js';
import { createKeyStoreFixture } from './helpers/keystore.js';

/** Poll until `predicate` holds (or fail after `timeoutMs`). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('resolveOwnCliPath', () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  async function tmp(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  it('resolves the flattened dist layout (sibling cli.js)', async () => {
    const dir = await tmp('ac2-resolve-flat-');
    await writeFile(join(dir, 'cli.js'), '');
    await writeFile(join(dir, 'control.agent.js'), '');
    const moduleUrl = pathToFileURL(join(dir, 'control.agent.js')).href;
    expect(resolveOwnCliPath(moduleUrl)).toBe(join(dir, 'cli.js'));
  });

  it('resolves the source layout (src/control/agent.ts -> src/cli.ts)', async () => {
    const root = await tmp('ac2-resolve-src-');
    const controlDir = join(root, 'src', 'control');
    await mkdir(controlDir, { recursive: true });
    await writeFile(join(root, 'src', 'cli.ts'), '');
    await writeFile(join(controlDir, 'agent.ts'), '');
    const moduleUrl = pathToFileURL(join(controlDir, 'agent.ts')).href;
    expect(resolveOwnCliPath(moduleUrl)).toBe(join(root, 'src', 'cli.ts'));
  });

  it('resolves an unflattened/nested dist layout (dist/control/agent.js -> dist/cli.js)', async () => {
    const root = await tmp('ac2-resolve-nested-');
    const controlDir = join(root, 'dist', 'control');
    await mkdir(controlDir, { recursive: true });
    await writeFile(join(root, 'dist', 'cli.js'), '');
    await writeFile(join(controlDir, 'agent.js'), '');
    const moduleUrl = pathToFileURL(join(controlDir, 'agent.js')).href;
    expect(resolveOwnCliPath(moduleUrl)).toBe(join(root, 'dist', 'cli.js'));
  });
});

describe('isStaleDaemonVersion', () => {
  it('is stale only when both versions are known and differ', () => {
    expect(isStaleDaemonVersion('1.0.0-canary.1', '1.0.0-canary.4')).toBe(true);
    expect(isStaleDaemonVersion('1.0.0-canary.4', '1.0.0-canary.4')).toBe(false);
  });

  it('never treats an unknown running version as stale (older daemon, no version reported)', () => {
    expect(isStaleDaemonVersion(undefined, '1.0.0-canary.4')).toBe(false);
    expect(isStaleDaemonVersion('', '1.0.0-canary.4')).toBe(false);
  });

  it('never restarts when the expected version is unknown or the check is disabled', () => {
    expect(isStaleDaemonVersion('1.0.0-canary.1', FALLBACK_DAEMON_VERSION)).toBe(false);
    expect(isStaleDaemonVersion('1.0.0-canary.1', null)).toBe(false);
  });
});

describe('ensureDaemonRunning', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ac2-ensure-running-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns immediately when the daemon is already running and reachable', async () => {
    const env = { ...process.env, AC2_HOME: tmpDir };
    // `daemonProcessStatus` only checks that the pidfile's PID is alive — the
    // test runner's own PID satisfies that without spawning anything.
    await writeFile(join(tmpDir, 'ac2d.pid'), `${process.pid}\n`);

    const socketPath = join(tmpDir, 'ac2d.sock');
    const server = createControlServer({ path: socketPath, handler: () => ({}) });
    await server.listen();
    try {
      await expect(
        ensureDaemonRunning({ env, socketPath, timeoutMs: 1000 }),
      ).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('does not restart a reachable daemon already on the expected version', async () => {
    const env = { ...process.env, AC2_HOME: tmpDir };
    await writeFile(join(tmpDir, 'ac2d.pid'), `${process.pid}\n`);

    const socketPath = join(tmpDir, 'ac2d.sock');
    let stopRequested = false;
    const server = createControlServer({
      path: socketPath,
      handler: (_client, method) => {
        if (method === 'daemon.stop') stopRequested = true;
        return { version: '1.0.0-canary.4', pid: process.pid };
      },
    });
    await server.listen();
    try {
      await expect(
        ensureDaemonRunning({
          env,
          socketPath,
          timeoutMs: 1000,
          expectedVersion: '1.0.0-canary.4',
        }),
      ).resolves.toBeUndefined();
      expect(stopRequested).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('leaves a stale OS-supervised daemon (no pidfile) alone, with an advisory log', async () => {
    const env = { ...process.env, AC2_HOME: tmpDir };
    // Deliberately no pidfile: an OS-supervised daemon writes none, so the
    // restart must not fire (it would only make the supervisor relaunch the
    // same old binary).
    const socketPath = join(tmpDir, 'ac2d.sock');
    let stopRequested = false;
    const server = createControlServer({
      path: socketPath,
      handler: (_client, method) => {
        if (method === 'daemon.stop') stopRequested = true;
        return { version: '1.0.0-canary.1', pid: process.pid };
      },
    });
    await server.listen();
    const logs: string[] = [];
    try {
      await expect(
        ensureDaemonRunning({
          env,
          socketPath,
          timeoutMs: 1000,
          expectedVersion: '1.0.0-canary.4',
          log: (message) => logs.push(message),
        }),
      ).resolves.toBeUndefined();
      expect(stopRequested).toBe(false);
      expect(logs.some((line) => line.includes('OS-supervised'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('throws a descriptive error when the daemon never becomes reachable', async () => {
    const env = { ...process.env, AC2_HOME: tmpDir };
    await writeFile(join(tmpDir, 'ac2d.pid'), `${process.pid}\n`);
    // Nothing listens here, and the pidfile makes daemonProcessStatus report
    // "running" so ensureDaemonRunning never attempts to spawn a real daemon.
    const socketPath = join(tmpDir, 'nobody-listening.sock');

    await expect(ensureDaemonRunning({ env, socketPath, timeoutMs: 300 })).rejects.toThrow(
      /daemon did not become reachable/,
    );
  });

  it('fails fast with the daemon-reported cause when startup fails (structured report, no log parsing)', async () => {
    const env = { ...process.env, AC2_HOME: tmpDir };
    await writeFile(join(tmpDir, 'ac2d.pid'), `${process.pid}\n`);
    const socketPath = join(tmpDir, 'nobody-listening.sock');

    // While the launcher is polling, the "daemon" crashes during startup and
    // leaves its structured report (exactly what `service run` does).
    const pending = ensureDaemonRunning({ env, socketPath, timeoutMs: 10_000 });
    const reported = (async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await reportStartupFailure(new Error('no Secret Service provider found'), env);
    })();

    const startedAt = Date.now();
    await expect(pending).rejects.toThrow(/failed to start: no Secret Service provider found/);
    await expect(pending).rejects.toThrow(/ac2 service logs/);
    // The reported cause short-circuits the poll loop instead of waiting out
    // the full 10s reachability timeout.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await reported;
  });

  it('ignores a stale startup-failure report left over from an earlier crash', async () => {
    const env = { ...process.env, AC2_HOME: tmpDir };
    await writeFile(join(tmpDir, 'ac2d.pid'), `${process.pid}\n`);
    // A report from a PREVIOUS start attempt must not fail this one.
    await reportStartupFailure(new Error('ancient keystore failure'), env);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const socketPath = join(tmpDir, 'nobody-listening.sock');

    const error = await ensureDaemonRunning({ env, socketPath, timeoutMs: 300 }).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error?.message).toMatch(/daemon did not become reachable/);
    expect(error?.message).not.toMatch(/ancient keystore failure/);
  });
});

describe('connectAgentSession', () => {
  let stateDir: string;
  let socketDir: string;
  let previousStateDir: string | undefined;
  let daemons: RunningDaemon[];
  let sessions: AgentSession[];
  let observers: ControlClient[];
  let socketCounter = 0;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'ac2-agent-test-state-'));
    socketDir = await mkdtemp(join(tmpdir(), 'ac2-agent-test-sock-'));
    previousStateDir = process.env['AC2_STATE_DIR'];
    process.env['AC2_STATE_DIR'] = stateDir;
    daemons = [];
    sessions = [];
    observers = [];
    socketCounter = 0;
  });

  afterEach(async () => {
    for (const session of sessions) {
      try {
        await session.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    for (const observer of observers) observer.close();
    for (const daemon of daemons) {
      try {
        await daemon.stop();
      } catch {
        // Best-effort cleanup.
      }
    }
    if (previousStateDir === undefined) delete process.env['AC2_STATE_DIR'];
    else process.env['AC2_STATE_DIR'] = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
  });

  async function startDaemon(): Promise<RunningDaemon> {
    const daemon = await runDaemon({
      socketPath: join(socketDir, `ac2d-${socketCounter++}.sock`),
      keystore: createKeyStoreFixture(stateDir).options(),
      handleSignals: false,
      hostKeystore: false,
      log: () => {},
      providerFactory: () => new InMemoryChannelProvider({ origin: 'https://debug.liquidauth.com' }),
    });
    daemons.push(daemon);
    return daemon;
  }

  it('registers the agent, delivers buffered events, and round-trips a send', async () => {
    const daemon = await startDaemon();
    const session = await connectAgentSession({
      agent: 'test-agent',
      autoStart: false,
      socketPath: daemon.socketPath,
      timeoutMs: 2000,
    });
    sessions.push(session);

    expect(session.protocolVersion).toBe(CONTROL_PROTOCOL_VERSION);
    expect(session.identity).toBeNull();
    expect(session.connection.state).toBe('idle');
    expect(session.connection.locked).toBe(false);

    // The daemon broadcasts `agent.registered` as part of handling
    // `agent.hello` — before this test had a chance to attach a listener.
    // It must still arrive once one is (buffered replay).
    const registeredEvents: unknown[] = [];
    session.on('agent.registered', (data) => registeredEvents.push(data));
    expect(registeredEvents).toEqual([{ agent: 'test-agent' }]);

    const delivered = await session.send('ping');
    expect(typeof delivered).toBe('boolean');

    const status = await session.status();
    expect(status.agents.map((a) => a.agent)).toContain('test-agent');
  });

  it('close() unregisters the agent (agent.unregistered is broadcast)', async () => {
    const daemon = await startDaemon();

    const observer = await connectControl({ path: daemon.socketPath, timeoutMs: 2000 });
    observers.push(observer);
    await observer.subscribe(['agent.unregistered']);
    const unregistered: unknown[] = [];
    observer.on('agent.unregistered', (data) => unregistered.push(data));

    const session = await connectAgentSession({
      agent: 'closing-agent',
      autoStart: false,
      socketPath: daemon.socketPath,
      timeoutMs: 2000,
    });
    await session.close();

    await waitFor(() => unregistered.length > 0);
    expect(unregistered[0]).toEqual({ agent: 'closing-agent' });
  });

  it('rejects a second session for the same agent id with an actionable agent_taken message', async () => {
    const daemon = await startDaemon();
    const first = await connectAgentSession({
      agent: 'dup-agent',
      autoStart: false,
      socketPath: daemon.socketPath,
      timeoutMs: 2000,
    });
    sessions.push(first);

    await expect(
      connectAgentSession({
        agent: 'dup-agent',
        autoStart: false,
        socketPath: daemon.socketPath,
        timeoutMs: 2000,
      }),
    ).rejects.toThrow(/already registered by another process/);
  });
});
