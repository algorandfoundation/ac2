import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';

import {
  attachHeartbeatResponder,
  closeAwareTransport,
  closeRtcDataChannel,
  buildSignalingSocketOptions,
  createPairingInvitation,
  isLiquidAuthPairingCredential,
  revokePairing,
  resolveHeartbeatTimeoutMs,
  waitForSignalingConnect,
} from '../src/providers/liquid-auth.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeSignalingSocket {
  connected = false;
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(listener);
    this.listeners.set(event, handlers);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

describe('Liquid Auth signaling authentication', () => {
  it('fails immediately with a stable code and removes phase listeners', async () => {
    const socket = new FakeSignalingSocket();
    const pending = waitForSignalingConnect(socket);
    const handshakeError = Object.assign(new Error('Invalid pairing credentials'), {
      data: { code: 'PAIRING_UNAUTHORIZED' },
    });

    socket.emit('connect_error', handshakeError);

    await expect(pending).rejects.toMatchObject({
      name: 'LiquidAuthPairingError',
      code: 'PAIRING_UNAUTHORIZED',
    });
    expect(socket.listenerCount('connect')).toBe(0);
    expect(socket.listenerCount('connect_error')).toBe(0);
  });

  it('ignores transient polling errors and resolves on a later reconnect', async () => {
    const socket = new FakeSignalingSocket();
    const pending = waitForSignalingConnect(socket);

    socket.emit('connect_error', Object.assign(new Error('xhr poll error'), {
      context: { status: 0 },
    }));
    expect(socket.listenerCount('connect')).toBe(1);
    expect(socket.listenerCount('connect_error')).toBe(1);

    socket.connected = true;
    socket.emit('connect');

    await expect(pending).resolves.toBeUndefined();
    expect(socket.listenerCount('connect')).toBe(0);
    expect(socket.listenerCount('connect_error')).toBe(0);
  });
});

describe('Liquid Auth durable pairing invitation', () => {
  const pairing = {
    version: 2 as const,
    pairingId: 'pairing-1',
    role: 'provider' as const,
    credential: 'provider-secret',
  };

  it('validates and authenticates the signaling socket with the exact credential', () => {
    expect(isLiquidAuthPairingCredential(pairing)).toBe(true);
    expect(buildSignalingSocketOptions(pairing)).toEqual({
      autoConnect: true,
      withCredentials: true,
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      auth: pairing,
    });
    expect(isLiquidAuthPairingCredential({ ...pairing, role: 'controller' })).toBe(false);
  });

  it('creates an invitation with an optional legacy request id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: 'Created',
      json: async () => pairing,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createPairingInvitation('https://liquid.example/', 'legacy-request-id'),
    ).resolves.toEqual(pairing);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://liquid.example/pairings/invitations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ requestId: 'legacy-request-id' }),
      }),
    );
  });

  it('rejects invalid invitation responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        statusText: 'Created',
        json: async () => ({ pairingId: 'missing-credential' }),
      }),
    );

    await expect(createPairingInvitation('https://liquid.example')).rejects.toThrow(
      'invalid provider credential',
    );
  });

  it('revokes with the provider bearer credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
    });
    vi.stubGlobal('fetch', fetchMock);

    await revokePairing('https://liquid.example/', pairing);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://liquid.example/pairings/pairing-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          authorization: 'Bearer provider-secret',
          'x-pairing-role': 'provider',
        },
      }),
    );
  });

  it.each([404, 410])('treats a %i revocation response as already removed', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: status === 404 ? 'Not Found' : 'Gone',
      }),
    );

    await expect(revokePairing('https://liquid.example/', pairing)).resolves.toBeUndefined();
  });

  it('does not hide an unauthenticated revocation response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    await expect(revokePairing('https://liquid.example/', pairing)).rejects.toThrow(
      '401 Unauthorized',
    );
  });
});

function makeBaseTransport(): Ac2Transport & { emitBaseClose: () => void; closes: () => number } {
  let closeHandler: (() => void) | undefined;
  let closes = 0;
  return {
    send: () => {},
    onMessage: () => {},
    onError: () => {},
    onOpen: () => {},
    onClose: (handler) => {
      closeHandler = handler;
    },
    close: () => {
      closes += 1;
    },
    get isOpen() {
      return true;
    },
    emitBaseClose: () => closeHandler?.(),
    closes: () => closes,
  };
}

describe('LiquidAuthChannelProvider heartbeat timeout', () => {
  it('is disabled by default so mobile background suspension is not treated as death', () => {
    expect(resolveHeartbeatTimeoutMs()).toBeUndefined();
    expect(resolveHeartbeatTimeoutMs('')).toBeUndefined();
  });

  it('accepts timeout overrides at or above two heartbeat intervals', () => {
    expect(resolveHeartbeatTimeoutMs('40000')).toBe(40_000);
    expect(resolveHeartbeatTimeoutMs(40_000)).toBe(40_000);
    expect(resolveHeartbeatTimeoutMs('900000')).toBe(900_000);
  });

  it('disables invalid or too-small overrides', () => {
    expect(resolveHeartbeatTimeoutMs('not-a-number')).toBeUndefined();
    expect(resolveHeartbeatTimeoutMs('39999')).toBeUndefined();
    expect(resolveHeartbeatTimeoutMs(39_999)).toBeUndefined();
  });

  it('wires ping responses immediately when a heartbeat channel is discovered', () => {
    const onInbound = vi.fn();
    const channel = {
      readyState: 'open',
      onmessage: null as ((event: { data: unknown }) => void) | null,
      send: vi.fn(),
    };

    attachHeartbeatResponder(channel, onInbound);
    channel.onmessage?.({ data: 'ping' });

    expect(onInbound).toHaveBeenCalledOnce();
    expect(channel.send).toHaveBeenCalledWith('pong');
  });

  it('records other heartbeat traffic without echoing it', () => {
    const onInbound = vi.fn();
    const channel = {
      readyState: 'open',
      onmessage: null as ((event: { data: unknown }) => void) | null,
      send: vi.fn(),
    };

    attachHeartbeatResponder(channel, onInbound);
    channel.onmessage?.({ data: 'pong' });

    expect(onInbound).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
  });
});

describe('closeRtcDataChannel', () => {
  it('closes non-closed DataChannels', () => {
    let closed = false;
    closeRtcDataChannel({
      readyState: 'open',
      close: () => {
        closed = true;
      },
    });
    expect(closed).toBe(true);
  });

  it('ignores absent, already closed, or throwing channels', () => {
    expect(() => closeRtcDataChannel(undefined)).not.toThrow();
    expect(() =>
      closeRtcDataChannel({
        readyState: 'closed',
        close: () => {
          throw new Error('should not be called');
        },
      }),
    ).not.toThrow();
    expect(() =>
      closeRtcDataChannel({
        readyState: 'closing',
        close: () => {
          throw new Error('already closing');
        },
      }),
    ).not.toThrow();
  });
});

describe('closeAwareTransport', () => {
  it('notifies every close listener when the base transport closes', () => {
    const base = makeBaseTransport();
    const { transport } = closeAwareTransport(base);
    const seen: string[] = [];

    transport.onClose(() => seen.push('client'));
    transport.onClose(() => seen.push('session-loop'));
    base.emitBaseClose();

    expect(seen).toEqual(['client', 'session-loop']);
  });

  it('emits close when the provider closes the transport even if the base does not', () => {
    const base = makeBaseTransport();
    const { transport, emitClose } = closeAwareTransport(base);
    const seen: string[] = [];

    transport.onClose(() => seen.push('session-loop'));
    emitClose();
    emitClose();

    expect(seen).toEqual(['session-loop']);
  });

  it('emits close from transport.close for native transports that do not emit onclose', () => {
    const base = makeBaseTransport();
    const { transport } = closeAwareTransport(base);
    let closed = 0;

    transport.onClose(() => {
      closed += 1;
    });
    transport.close();

    expect(base.closes()).toBe(1);
    expect(closed).toBe(1);
  });

  it('immediately calls listeners registered after close emission', () => {
    const base = makeBaseTransport();
    const { transport, emitClose } = closeAwareTransport(base);
    let closed = 0;

    emitClose();
    transport.onClose(() => {
      closed += 1;
    });

    expect(closed).toBe(1);
  });
});
