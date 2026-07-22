/**
 * Channel-bringup abstraction for AC2.
 *
 * `Ac2Transport` (in `../transport`) models the *wire-level* concern:
 * once we have a duplex byte/JSON pipe, frame AC2 messages over it.
 * `Ac2ChannelProvider` models the level immediately above: **how do we
 * obtain that pipe from a remote peer in the first place?**
 *
 * The SDK is deliberately agnostic about the answer. Liquid Auth +
 * WebRTC is one valid bringup. A WebSocket relay, a Bluetooth LE link,
 * a local Unix socket, or an in-memory pair for tests are all equally
 * valid. Each is a separate `Ac2ChannelProvider` implementation that
 * lives outside the core SDK (in its own file or package).
 *
 * Consumers (plugins, agent runtimes) depend on this interface — not on
 * any concrete signaling stack — so that swapping bringups is a
 * one-line wiring change at the entrypoint.
 *
 * The split mirrors the relationship between `Ac2Transport` and the
 * various `rtcDataChannelTransport` / `createInMemoryTransportPair`
 * adapters: a small, runtime-agnostic interface in the core, with
 * concrete adapters shipped separately.
 */

import type { Ac2Transport, RtcDataChannelLike } from '../transport/index.js';

/**
 * Free-form pairing payload a provider hands back to the caller so the
 * caller can render whatever UX the provider expects (QR code, copyable
 * URL, deep link, NFC tag, etc.). The SDK does not interpret the
 * payload; it just plumbs it through.
 */
export interface Ac2PairingInfo {
  /**
   * The payload to surface to the user (e.g. a URL to encode as a QR
   * code, a deep-link, or a short pairing code). Providers SHOULD make
   * this directly renderable so consumers can stay UX-agnostic.
   */
  qrPayload: string;
  /**
   * Provider-defined metadata. Free-form by design — e.g. a Liquid Auth
   * provider might include `{ origin, requestId }`; a BLE provider
   * might include `{ serviceUuid, deviceName }`. Consumers that need
   * provider-specific fields can read them here.
   */
  metadata?: Record<string, unknown>;
}

/**
 * What a paired session yields to its consumer once the remote peer has
 * completed the handshake.
 */
export interface Ac2PairedChannel {
  /**
   * The framed AC2 control-plane transport. Hand this to `new
   * Ac2Client(transport, opts)`.
   */
  transport: Ac2Transport;
  /**
   * Optional raw-byte side channel. Stays as `RtcDataChannelLike` (not
   * an `Ac2Transport`) because the SDK does not frame side-channel
   * traffic — it is bytes-only by design (e.g. `ac2-stream` carrying
   * arbitrary agent output). Providers that don't offer a side channel
   * omit this field.
   */
  streamChannel?: RtcDataChannelLike;
  /**
   * Optional identifier(s) of the remote peer the provider authenticated
   * during pairing.
   *
   * Free-form by design — providers populate only what they have:
   *  - A `LiquidAuthChannelProvider` may omit this entirely (the Liquid
   *    Auth bringup does not authenticate a peer DID).
   *  - A `DidCommRtcChannelProvider` populates `did` with the verified
   *    peer `did:key` produced by the DIDComm handshake, and MAY include
   *    additional fields (e.g. `thid` of the bringup thread for
   *    diagnostics / resumption).
   *
   * Consumers that don't need peer identity can ignore this field. Those
   * that do (e.g. to bind a session to a verified DID, to deduplicate
   * reconnections, or to display the peer in UX) can read it without
   * downcasting to a concrete provider type.
   */
  peer?: {
    /** Verified peer DID, when the bringup authenticates one. */
    did?: string;
    /** Additional provider-defined identity metadata. */
    [k: string]: unknown;
  };
  /** Tear down the underlying signaling + transport. Idempotent. */
  close(): Promise<void>;
}

/**
 * Options accepted by `Ac2ChannelProvider.startPairing`.
 */
export interface Ac2StartPairingOptions {
  /**
   * Caller-supplied abort signal. Aborting cancels the pairing attempt
   * (and any in-flight `connect()` promise) and tears down any partial
   * state.
   */
  signal?: AbortSignal;
  /**
   * Maximum time to wait for the remote peer to complete pairing. If
   * unset, the provider chooses a sensible default.
   */
  timeoutMs?: number;
}

/**
 * Result of `Ac2ChannelProvider.startPairing`. The provider returns
 * immediately with the pairing payload so the caller can render UX
 * synchronously; `connect()` then resolves when the remote peer has
 * completed the handshake and the channel is open.
 *
 * Splitting "begin pairing" from "await connection" lets the caller
 * render the QR (or equivalent) the instant it is available, rather
 * than blocking on a single all-in-one promise.
 */
export interface Ac2PairingHandle {
  /** Payload to surface to the user (QR, link, code, ...). */
  pairing: Ac2PairingInfo;
  /**
   * Resolves when the remote peer has completed pairing and the
   * channel is open. Rejects on timeout, abort, or signaling failure.
   *
   * Providers MAY support calling `connect()` more than once on the same
   * handle: each call (re)establishes the peer session over a persistent
   * signaling connection. This lets a caller answer a returning peer's fresh
   * bringup in place — without dropping the underlying signaling link — so a
   * reconnect does not churn presence or force the peer to re-pair.
   */
  connect(): Promise<Ac2PairedChannel>;
  /**
   * Optional: whether the provider's underlying signaling connection is still
   * live. When a paired channel drops, a caller can consult this to decide
   * between re-arming pairing on the SAME signaling connection (call
   * `connect()` again) versus starting a fresh pairing handle. Providers with
   * no persistent signaling connection omit this.
   */
  isSignalingAlive?(): boolean;
  /**
   * Optional: fully tear down the provider's persistent signaling connection
   * (and any peer session). Idempotent. Callers use this when abandoning a
   * handle whose signaling connection is still open (e.g. before replacing it
   * with a fresh handle). Providers with no persistent signaling connection
   * omit this.
   */
  dispose?(): Promise<void>;
}

/**
 * The single abstraction the plugin / agent runtime depends on.
 *
 * Implementations live outside the core SDK (e.g. a
 * `LiquidAuthChannelProvider` in the open-claw reference package, a
 * future `WebSocketChannelProvider`, or an `InMemoryChannelProvider`
 * for tests).
 */
export interface Ac2ChannelProvider {
  /**
   * Begin pairing. Returns immediately with the pairing payload so the
   * caller can render UX; `connect()` resolves when the remote peer
   * completes the handshake.
   */
  startPairing(opts?: Ac2StartPairingOptions): Promise<Ac2PairingHandle>;
}
