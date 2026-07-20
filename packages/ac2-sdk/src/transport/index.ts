/**
 * Transport abstraction for AC2.
 *
 * The spec mandates WebRTC DataChannel as the transport (label `ac2-v1`,
 * `ordered: true`, one AC2 message per DataChannel send). To keep the SDK
 * testable and reusable across runtimes (browser, React Native WebRTC,
 * Node + @roamhq/wrtc, in-memory pairs), we model the transport as a
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

/** Remove a previously registered transport listener. Safe to call more than once. */
export type Ac2Unsubscribe = () => void;

/**
 * Listener registration result.
 *
 * New transports SHOULD return an unsubscribe function. `void` remains allowed
 * so transports written against older SDK releases remain source-compatible.
 */
export type Ac2Subscription = Ac2Unsubscribe | void;

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
  onMessage(handler: Ac2MessageHandler): Ac2Subscription;
  /** Register an optional handler for inbound raw (non-AC2) messages. */
  onRawMessage?(handler: RawMessageHandler): Ac2Subscription;
  /**
   * Register an optional handler for inbound binary DataChannel frames.
   * If unregistered, binary frames are silently dropped (per spec).
   */
  onBinaryMessage?(handler: BinaryMessageHandler): Ac2Subscription;
  /** Register a handler for parse / transport errors. */
  onError(handler: Ac2ErrorHandler): Ac2Subscription;
  /** Register a handler for when the transport becomes ready. */
  onOpen(handler: Ac2EventHandler): Ac2Subscription;
  /** Register a handler for when the transport closes. */
  onClose(handler: Ac2EventHandler): Ac2Subscription;
  /** Close the transport. */
  close(): void;
  /** True once the transport is ready to send. */
  readonly isOpen: boolean;
}

/**
 * An AC2 transport whose listener registrations are all individually
 * disposable. The SDK's built-in transports implement this stronger contract.
 */
export interface Ac2DisposableTransport extends Ac2Transport {
  onMessage(handler: Ac2MessageHandler): Ac2Unsubscribe;
  onRawMessage(handler: RawMessageHandler): Ac2Unsubscribe;
  onBinaryMessage(handler: BinaryMessageHandler): Ac2Unsubscribe;
  onError(handler: Ac2ErrorHandler): Ac2Unsubscribe;
  onOpen(handler: Ac2EventHandler): Ac2Unsubscribe;
  onClose(handler: Ac2EventHandler): Ac2Unsubscribe;
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

function subscribe<T>(handlers: Set<T>, handler: T): Ac2Unsubscribe {
  handlers.add(handler);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    handlers.delete(handler);
  };
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
export function rtcDataChannelTransport(channel: RtcDataChannelLike): Ac2DisposableTransport {
  if (channel.label !== AC2_DATACHANNEL_LABEL) {
    throw new Error(
      `[ac2-sdk] DataChannel label MUST be "${AC2_DATACHANNEL_LABEL}" ` +
        `(got "${channel.label}")`,
    );
  }

  const messageHandlers = new Set<Ac2MessageHandler>();
  const rawMessageHandlers = new Set<RawMessageHandler>();
  const binaryMessageHandlers = new Set<BinaryMessageHandler>();
  const errorHandlers = new Set<Ac2ErrorHandler>();
  const openHandlers = new Set<Ac2EventHandler>();
  const closeHandlers = new Set<Ac2EventHandler>();

  channel.onopen = () => {
    for (const handler of [...openHandlers]) handler();
  };
  channel.onclose = () => {
    for (const handler of [...closeHandlers]) handler();
  };
  channel.onerror = (ev) => {
    const err = ev instanceof Error ? ev : new Error(`[ac2-sdk] DataChannel error: ${String(ev)}`);
    for (const handler of [...errorHandlers]) handler(err);
  };
  channel.onmessage = (ev) => {
    // Binary frames: route to the optional binary hook. Per SPEC.md →
    // WebRTC DataChannel Transport §3, attachments MAY be sent as binary
    // DataChannel messages — so this is NOT an error condition. If no
    // binary handler is registered, drop the frame silently.
    if (typeof ev.data !== 'string') {
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        for (const handler of [...binaryMessageHandlers]) handler(data);
      } else if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        const bytes = view.buffer.slice(
          view.byteOffset,
          view.byteOffset + view.byteLength,
        ) as ArrayBuffer;
        for (const handler of [...binaryMessageHandlers]) handler(bytes);
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
      for (const handler of [...rawMessageHandlers]) handler(raw);
      return;
    }

    if (!isAc2Message(parsed)) {
      // JSON but not AC2; treat as raw
      for (const handler of [...rawMessageHandlers]) handler(raw);
      return;
    }
    for (const handler of [...messageHandlers]) handler(parsed);
  };

  return {
    send(payload) {
      if (channel.readyState !== 'open') {
        throw new Error(`[ac2-sdk] Cannot send on DataChannel in state "${channel.readyState}"`);
      }
      channel.send(payload);
    },
    onMessage(h) {
      return subscribe(messageHandlers, h);
    },
    onRawMessage(h) {
      return subscribe(rawMessageHandlers, h);
    },
    onBinaryMessage(h) {
      return subscribe(binaryMessageHandlers, h);
    },
    onError(h) {
      return subscribe(errorHandlers, h);
    },
    onOpen(h) {
      const unsubscribe = subscribe(openHandlers, h);
      if (channel.readyState === 'open') h();
      return unsubscribe;
    },
    onClose(h) {
      const unsubscribe = subscribe(closeHandlers, h);
      if (channel.readyState === 'closed') h();
      return unsubscribe;
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
export function createInMemoryTransportPair(): [Ac2DisposableTransport, Ac2DisposableTransport] {
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

interface MemTransport extends Ac2DisposableTransport {
  _link(peer: MemTransport): void;
  _open(): void;
  _deliver(payload: string | ArrayBuffer | ArrayBufferView): void;
  _error(error: Error): void;
}

function makeMemTransport(): MemTransport {
  let peer: MemTransport | null = null;
  const messageHandlers = new Set<Ac2MessageHandler>();
  const rawMessageHandlers = new Set<RawMessageHandler>();
  const binaryMessageHandlers = new Set<BinaryMessageHandler>();
  const errorHandlers = new Set<Ac2ErrorHandler>();
  const openHandlers = new Set<Ac2EventHandler>();
  const closeHandlers = new Set<Ac2EventHandler>();
  let open = false;
  let closed = false;

  const t: MemTransport = {
    send(payload) {
      if (closed) throw new Error('[ac2-sdk] Transport is closed');
      if (!open || !peer) throw new Error('[ac2-sdk] Transport not open');
      // Deliver asynchronously to mimic real channel semantics.
      const target = peer;
      queueMicrotask(() => {
        try {
          target._deliver(payload);
        } catch (error) {
          target._error(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    onMessage(h) {
      return subscribe(messageHandlers, h);
    },
    onRawMessage(h) {
      return subscribe(rawMessageHandlers, h);
    },
    onBinaryMessage(h) {
      return subscribe(binaryMessageHandlers, h);
    },
    onError(h) {
      return subscribe(errorHandlers, h);
    },
    onOpen(h) {
      const unsubscribe = subscribe(openHandlers, h);
      if (open) h();
      return unsubscribe;
    },
    onClose(h) {
      const unsubscribe = subscribe(closeHandlers, h);
      if (closed) h();
      return unsubscribe;
    },
    close() {
      if (closed) return;
      closed = true;
      open = false;
      for (const handler of [...closeHandlers]) handler();
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
      for (const handler of [...openHandlers]) handler();
    },
    _error(error) {
      for (const handler of [...errorHandlers]) handler(error);
    },
    _deliver(payload) {
      if (typeof payload !== 'string') {
        const bytes = payload instanceof ArrayBuffer
          ? payload
          : payload.buffer.slice(
              payload.byteOffset,
              payload.byteOffset + payload.byteLength,
            ) as ArrayBuffer;
        for (const handler of [...binaryMessageHandlers]) handler(bytes);
        return;
      }
      if (payload.trim().length === 0) return; // Ignore heartbeats

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch (e) {
        // Not JSON; treat as raw chat
        for (const handler of [...rawMessageHandlers]) handler(payload);
        return;
      }
      if (!isAc2Message(parsed)) {
        // JSON but not AC2; treat as raw
        for (const handler of [...rawMessageHandlers]) handler(payload);
        return;
      }
      for (const handler of [...messageHandlers]) handler(parsed);
    },
  };
  return t;
}
