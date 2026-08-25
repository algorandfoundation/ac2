/**
 * `Ac2Transport` adapter over the daemon control socket.
 *
 * The daemon owns the *actual* wallet connection (WebRTC/Liquid Auth); an
 * agent host never touches it directly any more. This adapter lets any
 * agent (OpenClaw, Hermes, …) drive a normal `Ac2Client` — bootstrap
 * requests, signing requests, everything the SDK already knows how to do —
 * by forwarding `send()` over `agent.send` and re-hydrating `message.inbound`
 * notifications as if they had arrived on a real DataChannel.
 *
 * Framing mirrors the SDK's other adapters (`rtcDataChannelTransport`,
 * `createInMemoryTransportPair`): a payload that parses as a structurally
 * valid AC2 envelope (`isAc2Message`) goes to `onMessage`, everything else
 * (raw chat, control-frame text) goes to `onRawMessage`.
 */

import { isAc2Message } from '@algorandfoundation/ac2-sdk/schema';
import type {
  Ac2ErrorHandler,
  Ac2EventHandler,
  Ac2MessageHandler,
  Ac2Transport,
  RawMessageHandler,
} from '@algorandfoundation/ac2-sdk/transport';
import type { AgentSession } from './agent.js';
import type { ControlEventHandler } from './client.js';

export interface DaemonTransportOptions {
  /** Wallet channel this transport reads/writes (default `'control'`). */
  channel?: 'control' | 'stream';
  /**
   * Close the shared {@link AgentSession} when this transport is closed
   * (default `false` — the session usually outlives any one transport built
   * over it, e.g. a `stream`-channel `Sendable` built from the same session).
   */
  closeSession?: boolean;
}

/**
 * Wrap an {@link AgentSession} as an `Ac2Transport` for `Ac2Client`.
 *
 * `send()` is fire-and-forget: the underlying `session.send` is async (a
 * control-socket round trip), but `Ac2Transport.send` is synchronous by
 * contract, so failures surface through `onError` instead of a rejected
 * promise the caller has no way to await.
 */
export function createDaemonTransport(
  session: AgentSession,
  options: DaemonTransportOptions = {},
): Ac2Transport {
  const channel = options.channel ?? 'control';

  let messageHandler: Ac2MessageHandler | null = null;
  let rawMessageHandler: RawMessageHandler | null = null;
  let errorHandler: Ac2ErrorHandler | null = null;
  let openHandler: Ac2EventHandler | null = null;
  let closeHandler: Ac2EventHandler | null = null;
  // Seeded from the `agent.hello` snapshot so a caller that connects to an
  // already-connected daemon sees `isOpen === true` immediately, without
  // waiting on a `connection.connected` event that already fired for a
  // different (earlier) socket.
  let open = session.connection.state === 'connected';
  let closed = false;

  const onInbound: ControlEventHandler<'message.inbound'> = (data) => {
    if (data.channel !== channel) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.payload);
    } catch {
      rawMessageHandler?.(data.payload);
      return;
    }
    if (!isAc2Message(parsed)) {
      rawMessageHandler?.(data.payload);
      return;
    }
    messageHandler?.(parsed);
  };

  const onConnected: ControlEventHandler<'connection.connected'> = () => {
    open = true;
    openHandler?.();
  };

  const onDisconnected: ControlEventHandler<'connection.disconnected'> = () => {
    open = false;
    closeHandler?.();
  };

  session.on('message.inbound', onInbound);
  session.on('connection.connected', onConnected);
  session.on('connection.disconnected', onDisconnected);

  // The shared session closing (daemon gone, socket dropped) also closes
  // every transport built over it.
  void session.closed.then(() => {
    if (closed) return;
    open = false;
    closed = true;
    closeHandler?.();
  });

  return {
    send(payload) {
      session.send(payload, channel).catch((err) => {
        errorHandler?.(err instanceof Error ? err : new Error(String(err)));
      });
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onRawMessage(handler) {
      rawMessageHandler = handler;
    },
    onError(handler) {
      errorHandler = handler;
    },
    onOpen(handler) {
      openHandler = handler;
      if (open) handler();
    },
    onClose(handler) {
      closeHandler = handler;
    },
    close() {
      if (closed) return;
      closed = true;
      session.off('message.inbound', onInbound);
      session.off('connection.connected', onConnected);
      session.off('connection.disconnected', onDisconnected);
      if (options.closeSession) void session.close();
    },
    get isOpen() {
      return open && !closed;
    },
  };
}

/** The `ac2-stream` control-frame surface shape the OpenClaw plugin expects. */
export interface DaemonStreamSendable {
  send(payload: string): void;
  readonly isOpen: boolean;
}

export interface DaemonStreamSendableOptions {
  /**
   * Called with the payload when the daemon reports it could NOT deliver on
   * the `stream` channel — the connected wallet negotiated no `ac2-stream`
   * DataChannel (the control socket cannot tell us that up front, only
   * `agent.send`'s `delivered: false` can). The sendable also flips `isOpen`
   * to `false` for the rest of the session, so callers that pick a surface by
   * `isOpen` fall back to their primary transport on their own from then on.
   */
  onUndeliverable?: (payload: string) => void;
}

/**
 * Build a `Sendable`-shaped (`send` + `isOpen`) surface over the daemon's
 * `stream` channel — the counterpart to {@link createDaemonTransport} for
 * hosts (like the OpenClaw plugin) that keep a dedicated stream surface for
 * host-initiated control frames (`preview`/`finalize`/`notice`/…) separate
 * from the main AC2 protocol transport.
 */
export function createDaemonStreamSendable(
  session: AgentSession,
  options: DaemonStreamSendableOptions = {},
): DaemonStreamSendable {
  let open = session.connection.state === 'connected';

  session.on('connection.connected', () => {
    open = true;
  });
  session.on('connection.disconnected', () => {
    open = false;
  });
  void session.closed.then(() => {
    open = false;
  });

  return {
    send(payload) {
      void session
        .send(payload, 'stream')
        .then((delivered) => {
          if (delivered) return;
          open = false;
          options.onUndeliverable?.(payload);
        })
        .catch(() => {
          // Best-effort — matches `sendStreamControl`'s "advisory, never throws".
          open = false;
          options.onUndeliverable?.(payload);
        });
    },
    get isOpen() {
      return open;
    },
  };
}
