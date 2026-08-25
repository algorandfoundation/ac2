/**
 * Tests for the control-socket server and client.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  connectControl,
  createControlServer,
  resolveControlSocketPath,
  type ControlClient,
  type ControlEventName,
  type ControlServer,
} from '../src/control/index.js';

describe('ControlSocket', () => {
  let tmpDir: string;
  let socketPath: string;
  let servers: ControlServer[];
  let clients: ControlClient[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ac2-control-test-'));
    socketPath = join(tmpDir, 'ac2d.sock');
    servers = [];
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    for (const server of servers) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function startServer(
    handler?: Parameters<typeof createControlServer>[0]['handler'],
  ): Promise<ControlServer> {
    const server = createControlServer({
      path: socketPath,
      handler:
        handler ??
        ((client, method, params) => {
          if (method === 'subscribe') {
            const events = (params as { events?: ControlEventName[] }).events ?? [];
            for (const event of events) client.subscriptions.add(event);
            return { subscribed: [...client.subscriptions] };
          }
          if (method === 'daemon.stop') return { stopping: true };
          throw Object.assign(new Error('no such connection'), { code: 'not_found' });
        }),
    });
    servers.push(server);
    await server.listen();
    return server;
  }

  async function connect(): Promise<ControlClient> {
    const client = await connectControl({ path: socketPath, timeoutMs: 2000 });
    clients.push(client);
    return client;
  }

  it('completes a request/response round-trip', async () => {
    await startServer();
    const client = await connect();
    const result = await client.request('daemon.stop', {});
    expect(result).toEqual({ stopping: true });
  });

  it('rejects unknown methods with code bad_request', async () => {
    await startServer();
    const client = await connect();
    await expect(
      (client.request as (method: string, params: unknown) => Promise<unknown>)('nope.nope', {}),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('propagates handler error codes', async () => {
    await startServer();
    const client = await connect();
    await expect(client.request('connections.forget', {})).rejects.toMatchObject({
      code: 'not_found',
      message: 'no such connection',
    });
  });

  it('broadcasts events only to subscribed clients', async () => {
    const server = await startServer();
    const subscriber = await connect();
    const bystander = await connect();

    const subscriberEvents: unknown[] = [];
    const bystanderEvents: unknown[] = [];
    subscriber.on('agent.registered', (data) => subscriberEvents.push(data));
    bystander.on('agent.registered', (data) => bystanderEvents.push(data));

    const subscribed = await subscriber.subscribe(['agent.registered']);
    expect(subscribed).toEqual(['agent.registered']);

    server.broadcast('agent.registered', { agent: 'openclaw' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(subscriberEvents).toEqual([{ agent: 'openclaw' }]);
    expect(bystanderEvents).toEqual([]);
  });

  it('rejects pending requests when the server closes', async () => {
    const server = await startServer(() => new Promise(() => {}));
    const client = await connect();
    const pending = client.request('daemon.status', {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await server.close();
    await expect(pending).rejects.toThrow();
  });

  it('takes over a stale socket file', async () => {
    await writeFile(socketPath, 'stale');
    await startServer();
    const client = await connect();
    const result = await client.request('daemon.stop', {});
    expect(result).toEqual({ stopping: true });
  });

  it('refuses to listen when another server owns the socket', async () => {
    await startServer();
    const second = createControlServer({
      path: socketPath,
      handler: () => ({}),
    });
    await expect(second.listen()).rejects.toThrow(/daemon already running/);
  });
});

describe('resolveControlSocketPath', () => {
  const WIN_PIPE = '\\\\.\\pipe\\ac2-daemon';

  it('uses a socket file inside AC2_HOME on Linux and macOS', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(resolveControlSocketPath({ AC2_HOME: '/srv/ac2' }, platform)).toBe(
        join('/srv/ac2', 'ac2d.sock'),
      );
    }
  });

  it('uses the historical named pipe on Windows with the default home', () => {
    expect(resolveControlSocketPath({}, 'win32')).toBe(WIN_PIPE);
  });

  it('gives every custom AC2_HOME its own Windows pipe', () => {
    const first = resolveControlSocketPath({ AC2_HOME: 'C:\\ac2\\profile-a' }, 'win32');
    const second = resolveControlSocketPath({ AC2_HOME: 'C:\\ac2\\profile-b' }, 'win32');
    expect(first.startsWith(`${WIN_PIPE}-`)).toBe(true);
    expect(first.slice(WIN_PIPE.length + 1)).toMatch(/^[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
    // Stable across calls, so client and daemon always agree.
    expect(resolveControlSocketPath({ AC2_HOME: 'C:\\ac2\\profile-a' }, 'win32')).toBe(first);
  });

  it('always honours an explicit AC2_DAEMON_SOCKET override', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(
        resolveControlSocketPath(
          { AC2_DAEMON_SOCKET: '  \\\\.\\pipe\\custom  ', AC2_HOME: '/srv/ac2' },
          platform,
        ),
      ).toBe('\\\\.\\pipe\\custom');
    }
  });
});
