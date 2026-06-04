/**
 * Transport abstraction for AC2.
 *
 * The spec mandates WebRTC DataChannel as the transport (label `ac2-v1`,
 * `ordered: true`, one AC2 message per DataChannel send). To keep the SDK
 * testable and reusable across runtimes (browser, React Native WebRTC,
 * Node + node-datachannel, in-memory pairs), we model the transport as a
 * tiny duplex interface and ship two adapters:
 *
 *   - `rtcDataChannelTransport(channel)` — wraps an existing
 *     `RTCDataChannel`-shaped object that already has label `ac2-v1`.
 *   - `createInMemoryTransportPair()` — two connected transports for tests.
 *
 * The transport handles **framing only** (one JSON string per send/recv).
 * Envelope/body validation happens one level up, in `Ac2Client`.
 */

import { isAc2Message, type AC2BaseMessage } from '../schema/index.js';

export const AC2_DATACHANNEL_LABEL = 'ac2-v1' as const;

/** Callback invoked on every successfully-parsed inbound AC2 message. */
export type Ac2MessageHandler = (msg: AC2BaseMessage) => void;

/** Callback invoked on transport-level or parse errors. */
export type Ac2ErrorHandler = (err: Error) => void;

/** Lifecycle event handler. */
export type Ac2EventHandler = () => void;

/** Callback for raw (non-AC2 JSON) messages. Used for chat. */
export type RawMessageHandler = (payload: string) => void;

/**
 * Callback for inbound binary DataChannel payloads.
 *
 * `SPEC.md` → *WebRTC DataChannel Transport* §3 explicitly allows binary
 * attachments and side-channel byte streams; non-string frames are
 * therefore NOT an error. If no `onBinaryMessage` handler is registered
 * the frame is silently dropped.
 */
export type BinaryMessageHandler = (data: ArrayBuffer) => void;

/**
 * Minimal duplex transport AC2 needs.
 *
 * Implementations MUST deliver one AC2 message per `onMessage` call (no
 * partial messages, no merging). String payloads are JSON-serialized AC2
 * envelopes.
 */
export interface Ac2Transport {
  /** Send a single, already-serialized AC2 message. */
  send(payload: string): void;
  /** Register a handler for inbound, parsed AC2 messages. */
  onMessage(handler: Ac2MessageHandler): void;
  /** Register a optional handler for inbound raw (non-AC2) messages. */
  onRawMessage?(handler: RawMessageHandler): void;
  /**
   * Register an optional handler for inbound binary DataChannel frames.
   * If unregistered, binary frames are silently dropped (per spec).
   */
  onBinaryMessage?(handler: BinaryMessageHandler): void;
  /** Register a handler for parse / transport errors. */
  onError(handler: Ac2ErrorHandler): void;
  /** Register a handler for when the transport becomes ready. */
  onOpen(handler: Ac2EventHandler): void;
  /** Register a handler for when the transport closes. */
  onClose(handler: Ac2EventHandler): void;
  /** Close the transport. */
  close(): void;
  /** True once the transport is ready to send. */
  readonly isOpen: boolean;
}

// ---------------------------------------------------------------------------
// Minimal structural type for an RTCDataChannel-ish object
// ---------------------------------------------------------------------------

/**
 * The subset of `RTCDataChannel` AC2 actually uses. Declared structurally so
 * the SDK does not depend on lib.dom or any specific WebRTC binding.
 */
export interface RtcDataChannelLike {
  readonly label: string;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/**
 * Wrap an existing `RTCDataChannel` (or compatible object) as an
 * `Ac2Transport`. The caller is responsible for creating the DataChannel
 * with the spec-mandated parameters:
 *
 *   peerConnection.createDataChannel('ac2-v1', { ordered: true })
 *
 * The wrapper enforces that the label matches `ac2-v1` and throws otherwise.
 */
export function rtcDataChannelTransport(channel: RtcDataChannelLike): Ac2Transport {
  if (channel.label !== AC2_DATACHANNEL_LABEL) {
    throw new Error(
      `[ac2-sdk] DataChannel label MUST be "${AC2_DATACHANNEL_LABEL}" ` +
        `(got "${channel.label}")`,
    );
  }

  let messageHandler: Ac2MessageHandler | null = null;
  let rawMessageHandler: RawMessageHandler | null = null;
  let binaryMessageHandler: BinaryMessageHandler | null = null;
  let errorHandler: Ac2ErrorHandler | null = null;
  let openHandler: Ac2EventHandler | null = null;
  let closeHandler: Ac2EventHandler | null = null;

  channel.onopen = () => openHandler?.();
  channel.onclose = () => closeHandler?.();
  channel.onerror = (ev) => {
    const err = ev instanceof Error ? ev : new Error(`[ac2-sdk] DataChannel error: ${String(ev)}`);
    errorHandler?.(err);
  };
  channel.onmessage = (ev) => {
    // Binary frames: route to the optional binary hook. Per SPEC.md →
    // WebRTC DataChannel Transport §3, attachments MAY be sent as binary
    // DataChannel messages — so this is NOT an error condition. If no
    // binary handler is registered, drop the frame silently.
    if (typeof ev.data !== 'string') {
      if (!binaryMessageHandler) return;
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        binaryMessageHandler(data);
      } else if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        binaryMessageHandler(
          view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
        );
      }
      // Other shapes (e.g. Blob) are intentionally unhandled; consumers
      // that need Blob support should set `channel.binaryType = 'arraybuffer'`.
      return;
    }
    const raw = ev.data;
    if (raw.trim().length === 0) return; // Ignore heartbeats

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Not JSON; treat as raw chat
      rawMessageHandler?.(raw);
      return;
    }

    if (!isAc2Message(parsed)) {
      // JSON but not AC2; treat as raw
      rawMessageHandler?.(raw);
      return;
    }
    messageHandler?.(parsed);
  };

  return {
    send(payload) {
      if (channel.readyState !== 'open') {
        throw new Error(`[ac2-sdk] Cannot send on DataChannel in state "${channel.readyState}"`);
      }
      channel.send(payload);
    },
    onMessage(h) {
      messageHandler = h;
    },
    onRawMessage(h) {
      rawMessageHandler = h;
    },
    onBinaryMessage(h) {
      binaryMessageHandler = h;
    },
    onError(h) {
      errorHandler = h;
    },
    onOpen(h) {
      openHandler = h;
      if (channel.readyState === 'open') h();
    },
    onClose(h) {
      closeHandler = h;
    },
    close() {
      channel.close();
    },
    get isOpen() {
      return channel.readyState === 'open';
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory transport pair (for tests)
// ---------------------------------------------------------------------------

/**
 * Create two transports wired directly to each other. Anything sent on `a`
 * surfaces on `b.onMessage` (and vice versa). Useful for unit tests of the
 * `Ac2Client` and for plumbing higher-level flows without a real DataChannel.
 */
export function createInMemoryTransportPair(): [Ac2Transport, Ac2Transport] {
  const a = makeMemTransport();
  const b = makeMemTransport();
  a._link(b);
  b._link(a);
  // Both ends are open synchronously so callers can `send()` immediately
  // after construction. `onOpen` handlers registered later still fire (see
  // `onOpen` implementation below).
  a._open();
  b._open();
  return [a, b];
}

interface MemTransport extends Ac2Transport {
  _link(peer: MemTransport): void;
  _open(): void;
  _deliver(payload: string): void;
}

function makeMemTransport(): MemTransport {
  let peer: MemTransport | null = null;
  let messageHandler: Ac2MessageHandler | null = null;
  let rawMessageHandler: RawMessageHandler | null = null;
  let errorHandler: Ac2ErrorHandler | null = null;
  let openHandler: Ac2EventHandler | null = null;
  let closeHandler: Ac2EventHandler | null = null;
  let open = false;
  let closed = false;

  const t: MemTransport = {
    send(payload) {
      if (closed) throw new Error('[ac2-sdk] Transport is closed');
      if (!open || !peer) throw new Error('[ac2-sdk] Transport not open');
      // Deliver asynchronously to mimic real channel semantics.
      const target = peer;
      queueMicrotask(() => target._deliver(payload));
    },
    onMessage(h) {
      messageHandler = h;
    },
    onRawMessage(h) {
      rawMessageHandler = h;
    },
    onError(h) {
      errorHandler = h;
    },
    onOpen(h) {
      openHandler = h;
      if (open) h();
    },
    onClose(h) {
      closeHandler = h;
    },
    close() {
      if (closed) return;
      closed = true;
      open = false;
      closeHandler?.();
      const p = peer;
      peer = null;
      if (p && !(p as unknown as { _isClosed?: boolean })._isClosed) {
        p.close();
      }
    },
    get isOpen() {
      return open;
    },
    _link(p) {
      peer = p;
    },
    _open() {
      if (closed || open) return;
      open = true;
      openHandler?.();
    },
    _deliver(payload) {
      if (payload.trim().length === 0) return; // Ignore heartbeats

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch (e) {
        // Not JSON; treat as raw chat
        rawMessageHandler?.(payload);
        return;
      }
      if (!isAc2Message(parsed)) {
        // JSON but not AC2; treat as raw
        rawMessageHandler?.(payload);
        return;
      }
      messageHandler?.(parsed);
    },
  };
  return t;
}
