/**
 * Tests for {@link daemonLiveness}.
 *
 * The bug being pinned down: a daemon under OS supervision (launchd/systemd)
 * runs `service run` in the foreground and writes NO pidfile, so the old
 * pidfile-only check reported a healthy supervised service as "daemon is not
 * running" — and made the auto-start path spawn a second daemon on top of it.
 * The live control socket therefore wins over the pidfile.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { daemonLiveness } from '../src/daemon/liveness.js';
import { createControlServer, type ControlServer } from '../src/control/index.js';
import type { DaemonStatus } from '../src/control/protocol.js';

/** A minimal `daemon.status` payload — only `pid` is read by the liveness probe. */
const statusFor = (pid: number): DaemonStatus =>
  ({
    pid,
    startedAt: new Date().toISOString(),
    version: 'test',
    serviceDid: null,
    keystoreSocket: null,
    defaultAgent: 'openclaw',
    runtimeAdapter: 'socket',
    waitingForRuntime: false,
    pairing: null,
    connection: { state: 'idle', walletAddress: null, controllerDid: null },
    agents: [],
  }) as unknown as DaemonStatus;

/** A fake control client that answers `daemon.status`, recording its close. */
const fakeClient = (pid: number, closed: { value: boolean }) =>
  ({
    request: async () => statusFor(pid),
    close: () => {
      closed.value = true;
    },
  }) as never;

describe('daemonLiveness', () => {
  it('reports running from the control socket even with no pidfile', async () => {
    const closed = { value: false };
    const liveness = await daemonLiveness({
      connect: async () => fakeClient(4242, closed),
      processStatus: async () => ({ running: false, pid: null, stale: false }),
    });

    expect(liveness).toMatchObject({ running: true, pid: 4242, source: 'control-socket' });
    expect(liveness.status?.pid).toBe(4242);
    // The probe must never leak the connection it opened.
    expect(closed.value).toBe(true);
  });

  it('prefers the daemon-reported pid over the pidfile', async () => {
    const closed = { value: false };
    const liveness = await daemonLiveness({
      connect: async () => fakeClient(4242, closed),
      processStatus: async () => ({ running: true, pid: 1, stale: false }),
    });
    expect(liveness.pid).toBe(4242);
  });

  it('falls back to the pidfile when the socket does not answer', async () => {
    const liveness = await daemonLiveness({
      connect: async () => {
        throw new Error('ENOENT: no such socket');
      },
      processStatus: async () => ({ running: true, pid: 99, stale: false }),
    });

    expect(liveness).toEqual({
      running: true,
      pid: 99,
      source: 'pidfile',
      socketError: 'ENOENT: no such socket',
    });
    expect(liveness.status).toBeUndefined();
  });

  it('falls back to the pidfile when the daemon connects but cannot answer', async () => {
    const closed = { value: false };
    const liveness = await daemonLiveness({
      connect: async () =>
        ({
          request: async () => {
            throw new Error('request timed out');
          },
          close: () => {
            closed.value = true;
          },
        }) as never,
      processStatus: async () => ({ running: true, pid: 7, stale: false }),
    });

    expect(liveness).toMatchObject({ running: true, pid: 7, source: 'pidfile' });
    expect(liveness.socketError).toBe('request timed out');
    expect(closed.value).toBe(true);
  });

  it('reports not running when neither signal is there', async () => {
    const liveness = await daemonLiveness({
      connect: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      processStatus: async () => ({ running: false, pid: null, stale: false }),
    });

    expect(liveness).toEqual({
      running: false,
      pid: null,
      source: 'none',
      socketError: 'connect ECONNREFUSED',
    });
  });

  it('resolves the socket from the passed env when no path is given', async () => {
    let seenPath: string | undefined;
    await daemonLiveness({
      env: { AC2_HOME: '/srv/ac2' },
      connect: async (options) => {
        seenPath = options.path;
        throw new Error('nope');
      },
      processStatus: async () => ({ running: false, pid: null, stale: false }),
    });
    expect(seenPath).toBe(join('/srv/ac2', 'ac2d.sock'));
  });
});

describe('daemonLiveness (real control socket, no pidfile)', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: ControlServer | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ac2-liveness-'));
    socketPath = join(tmpDir, 'ac2d.sock');
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports the supervised daemon as running', async () => {
    server = createControlServer({
      path: socketPath,
      handler: (_client, method) => {
        if (method === 'daemon.status') return statusFor(1234);
        throw Object.assign(new Error('unexpected'), { code: 'bad_request' });
      },
    });
    await server.listen();

    // A supervised daemon writes no pidfile: AC2_HOME holds only the socket.
    const liveness = await daemonLiveness({ env: { AC2_HOME: tmpDir }, timeoutMs: 2000 });
    expect(liveness).toMatchObject({ running: true, pid: 1234, source: 'control-socket' });
  });

  it('reports not running for a home with a stale socket file and no daemon', async () => {
    await writeFile(socketPath, 'stale');
    const liveness = await daemonLiveness({ env: { AC2_HOME: tmpDir }, timeoutMs: 500 });
    expect(liveness.running).toBe(false);
    expect(liveness.source).toBe('none');
  });
});
