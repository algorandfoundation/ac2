/**
 * Liquid Auth `Ac2ChannelProvider`. Requests the AC2 channels by spec label
 * (`ac2-v1`, `ac2-stream`) and hands the control channel to `Ac2Client` via
 * `rtcDataChannelTransport`. A third `ac2-heartbeat` DataChannel is also
 * negotiated but kept fully out-of-band: it is pinged inside this provider
 * for liveness and never exposed on the returned `Ac2PairedChannel`.
 */

import type {
  Ac2ChannelProvider,
  Ac2PairedChannel,
  Ac2PairingHandle,
  Ac2PairingInfo,
  Ac2StartPairingOptions,
} from '@algorandfoundation/ac2-sdk/signaling';
import { rtcDataChannelTransport, type Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';
import qrcode from 'qrcode-terminal';
import { normalizeDidKey } from '../identity/did.js';

// @ts-ignore - compiled JS in node_modules
import { SignalClient } from '@algorandfoundation/liquid-client/signal';
import { io as createSocketIoClient } from 'socket.io-client';

let webRtcPolyfillReady: Promise<void> | undefined;

async function ensureWebRtcPolyfill(): Promise<void> {
  if (typeof (globalThis as any).RTCPeerConnection !== 'undefined') return;
  webRtcPolyfillReady ??= (async () => {
    // @roamhq/wrtc: libwebrtc-backed Node WebRTC bindings, shipped as prebuilt
    // platform binaries. Import lazily so plugin discovery/CLI startup does not
    // require loading the native module.
    const wrtc: any = await import('@roamhq/wrtc');
    const rtc = wrtc.default ?? wrtc;

    // Subclass RTCPeerConnection to queue remote ICE candidates that arrive via
    // trickle before setRemoteDescription completes. The Liquid Auth SignalClient
    // can race between trickling candidates and the offer/answer exchange, and
    // adding a candidate before the remote description is set can throw instead
    // of buffering silently.
    class Ac2RTCPeerConnection extends rtc.RTCPeerConnection {
      private _ac2PendingCandidates: any[] = [];
      private _ac2RemoteDescReady = false;

      async setRemoteDescription(desc: any): Promise<void> {
        this._ac2RemoteDescReady = false;
        await super.setRemoteDescription(desc);
        this._ac2RemoteDescReady = true;
        const queued = this._ac2PendingCandidates.splice(0);
        for (const c of queued) {
          try {
            await super.addIceCandidate(c);
          } catch {
            // Stale or invalid candidate after drain — safe to ignore.
          }
        }
      }

      async addIceCandidate(candidate: any): Promise<void> {
        if (!this._ac2RemoteDescReady) {
          this._ac2PendingCandidates.push(candidate);
          return;
        }
        return super.addIceCandidate(candidate);
      }
    }

    (globalThis as any).RTCPeerConnection = Ac2RTCPeerConnection;
    (globalThis as any).RTCIceCandidate = rtc.RTCIceCandidate;
    (globalThis as any).RTCSessionDescription = rtc.RTCSessionDescription;
    if (rtc.RTCDataChannel) {
      (globalThis as any).RTCDataChannel = rtc.RTCDataChannel;
    }
  })();
  await webRtcPolyfillReady;
}

/** Render a pairing payload to the terminal (QR + raw string). */
export function renderPairingQr(pairing: Ac2PairingInfo): void {
  const isTty = typeof process !== 'undefined' && Boolean(process.stdout?.isTTY);
  if (isTty) qrcode.generate(pairing.qrPayload, { small: true });
  // eslint-disable-next-line no-console
  console.log(`[ac2-open-claw] Pair with Controller: ${pairing.qrPayload}`);
}

// STUN/TURN mirrored from the AC2 Controller app's answer side.
const AC2_ICE_CONFIG: any = {
  iceServers: [
    {
      urls: ['stun:geo.turn.algonode.xyz:80', 'stun:global.turn.nodely.io:443'],
    },
    {
      urls: [
        'turn:geo.turn.algonode.xyz:80?transport=tcp',
        'turns:global.turn.nodely.io:443?transport=tcp',
      ],
      username: 'liquid-auth',
      credential: 'sqmcP4MiTKMT4TGEDSk9jgHY',
    },
  ],
  iceCandidatePoolSize: 10,
};

const AC2_HEARTBEAT_MS = 20000;
const AC2_CONTROL_LABEL = 'ac2-v1' as const;
const AC2_STREAM_LABEL = 'ac2-stream' as const;
/** Dedicated liveness channel — keeps keepalive off the control plane. */
const AC2_HEARTBEAT_LABEL = 'ac2-heartbeat' as const;
const AC2_HEARTBEAT_PING = 'ping' as const;
const AC2_HEARTBEAT_PONG = 'pong' as const;

export function closeRtcDataChannel(channel: unknown): void {
  if (
    channel &&
    typeof (channel as { close?: unknown }).close === 'function' &&
    (channel as { readyState?: unknown }).readyState !== 'closed'
  ) {
    try {
      (channel as { close: () => void }).close();
    } catch {
      // Already closing/closed; ignore.
    }
  }
}

export function closeAwareTransport(base: Ac2Transport): {
  transport: Ac2Transport;
  emitClose: () => void;
} {
  const closeHandlers = new Set<() => void>();
  let closeEmitted = false;

  const emitClose = (): void => {
    if (closeEmitted) return;
    closeEmitted = true;
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch {
        // Close notifications are best-effort; keep notifying the rest.
      }
    }
    closeHandlers.clear();
  };

  base.onClose(emitClose);

  const transport: Ac2Transport = {
    send: (payload) => base.send(payload),
    onMessage: (handler) => base.onMessage(handler),
    onRawMessage: (handler) => base.onRawMessage?.(handler),
    onBinaryMessage: (handler) => base.onBinaryMessage?.(handler),
    onError: (handler) => base.onError(handler),
    onOpen: (handler) => base.onOpen(handler),
    onClose: (handler) => {
      if (closeEmitted) {
        handler();
        return;
      }
      closeHandlers.add(handler);
    },
    close: () => {
      try {
        base.close();
      } finally {
        emitClose();
      }
    },
    get isOpen() {
      return base.isOpen;
    },
  };

  return { transport, emitClose };
}

export function resolveHeartbeatTimeoutMs(value?: string | number): number | undefined {
  // Mobile runtimes suspend JavaScript in the background, so lack of an
  // application-level pong is not proof that the native WebRTC peer is dead.
  // Keep the timeout opt-in and rely on DataChannel/ICE close events by default.
  if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) {
    return undefined;
  }
  const parsed = Number(value);
  const minimum = AC2_HEARTBEAT_MS * 2;
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : undefined;
}

interface HeartbeatDataChannelLike {
  readyState?: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(payload: string): void;
}

/** Install heartbeat liveness and ping-response handling as soon as a channel is discovered. */
export function attachHeartbeatResponder(
  channel: HeartbeatDataChannelLike,
  onInbound: () => void,
): void {
  channel.onmessage = (event: { data: unknown }) => {
    onInbound();
    if (event?.data !== AC2_HEARTBEAT_PING || channel.readyState !== 'open') return;
    try {
      channel.send(AC2_HEARTBEAT_PONG);
    } catch {
      // Channel closing between check and send; ignore.
    }
  };
}

/** Durable provider credential issued by the Liquid Auth pairing service. */
export interface LiquidAuthPairingCredential {
  version: 2;
  pairingId: string;
  role: 'provider';
  credential: string;
}

export type LiquidAuthPairingErrorCode = 'PAIRING_UNAUTHORIZED' | 'PAIRING_REVOKED';

/** Stable pairing-auth failure surfaced by the Socket.IO handshake. */
export class LiquidAuthPairingError extends Error {
  readonly code: LiquidAuthPairingErrorCode;

  constructor(code: LiquidAuthPairingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LiquidAuthPairingError';
    this.code = code;
  }
}

/** Read an explicit server pairing error without classifying transient network failures. */
export function getLiquidAuthPairingErrorCode(
  error: unknown,
): LiquidAuthPairingErrorCode | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as {
      code?: unknown;
      data?: { code?: unknown };
      cause?: unknown;
    };
    const code = record.code ?? record.data?.code;
    if (code === 'PAIRING_UNAUTHORIZED' || code === 'PAIRING_REVOKED') return code;
    current = record.cause;
  }
  return undefined;
}

interface SignalingSocketLike {
  connected?: boolean;
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'connect_error', listener: (error: unknown) => void): unknown;
  off(event: 'connect', listener: () => void): unknown;
  off(event: 'connect_error', listener: (error: unknown) => void): unknown;
}

/** Wait for signaling while failing fast only for explicit credential rejection. */
export function waitForSignalingConnect(socket: SignalingSocketLike): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
    };
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onConnect = (): void => finish(resolve);
    const onConnectError = (error: unknown): void => {
      const code = getLiquidAuthPairingErrorCode(error);
      if (!code) return;
      const fallback =
        code === 'PAIRING_REVOKED'
          ? 'Pairing has been revoked'
          : 'Pairing credential was not accepted';
      const message =
        error instanceof Error && error.message.length > 0 ? error.message : fallback;
      finish(() => reject(new LiquidAuthPairingError(code, message, { cause: error })));
    };

    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    // Close the race where the socket connected between the first check and
    // listener registration.
    if (socket.connected) onConnect();
  });
}

export function isLiquidAuthPairingCredential(
  value: unknown,
): value is LiquidAuthPairingCredential {
  if (value === null || typeof value !== 'object') return false;
  const pairing = value as Partial<LiquidAuthPairingCredential>;
  return (
    pairing.version === 2 &&
    pairing.role === 'provider' &&
    typeof pairing.pairingId === 'string' &&
    pairing.pairingId.length > 0 &&
    typeof pairing.credential === 'string' &&
    pairing.credential.length > 0
  );
}

/** Create a durable invitation when no provider credential has been persisted. */
export async function createPairingInvitation(
  origin: string,
  requestId?: string,
  signal?: AbortSignal,
): Promise<LiquidAuthPairingCredential> {
  const response = await fetch(`${origin.replace(/\/$/, '')}/pairings/invitations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestId ? { requestId } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `[ac2] Liquid Auth invitation failed (${response.status} ${response.statusText})`,
    );
  }
  const pairing: unknown = await response.json();
  if (!isLiquidAuthPairingCredential(pairing)) {
    throw new Error('[ac2] Liquid Auth invitation returned an invalid provider credential');
  }
  return pairing;
}

/** Revoke a durable pairing. A missing record is already effectively revoked. */
export async function revokePairing(
  origin: string,
  pairing: LiquidAuthPairingCredential,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${origin.replace(/\/$/, '')}/pairings/${encodeURIComponent(pairing.pairingId)}`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${pairing.credential}`,
        'x-pairing-role': pairing.role,
      },
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new Error(
      `[ac2] Liquid Auth pairing revocation failed (${response.status} ${response.statusText})`,
    );
  }
}

export function buildSignalingSocketOptions(pairing: LiquidAuthPairingCredential): {
  autoConnect: true;
  withCredentials: true;
  transports: ['websocket', 'polling'];
  tryAllTransports: true;
  auth: LiquidAuthPairingCredential;
} {
  return {
    autoConnect: true,
    withCredentials: true,
    // Prefer a real WebSocket so deployments that reject Engine.IO's XHR
    // polling transport do not get stuck in a connect_error loop. Retain
    // polling as a compatibility fallback for networks that block WebSockets.
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    auth: pairing,
  };
}

function pairingAbortError(): Error {
  const error = new Error('[ac2] Pairing aborted');
  error.name = 'AbortError';
  return error;
}

function waitForPairingPhase<T>(
  promise: Promise<T>,
  options: Ac2StartPairingOptions,
  phase: string,
): Promise<T> {
  const { signal, timeoutMs } = options;
  if (signal?.aborted) return Promise.reject(pairingAbortError());
  if (signal === undefined && timeoutMs === undefined) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = (): void => settle(() => reject(pairingAbortError()));

    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timeout = setTimeout(
        () => settle(() => reject(new Error(`[ac2] Timeout waiting for ${phase}`))),
        timeoutMs,
      );
    }
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

export interface LiquidAuthChannelProviderOptions {
  /** Liquid Auth signaling server origin. */
  origin?: string;
  /** Pre-supplied requestId (otherwise `SignalClient.generateRequestId()`). */
  requestId?: string;
  /** Durable provider credential returned by `/pairings/invitations`. */
  pairing?: LiquidAuthPairingCredential;
  /** Request the optional `ac2-stream` channel (default `true`). */
  includeStreamChannel?: boolean;
  /**
   * Optional milliseconds without inbound heartbeat traffic before closing.
   * Disabled by default because mobile controllers can suspend JavaScript in
   * the background while their native WebRTC connection remains valid. Values
   * below two heartbeat intervals (40 seconds) are ignored.
   */
  heartbeatTimeoutMs?: number;
}

export class LiquidAuthChannelProvider implements Ac2ChannelProvider {
  constructor(private readonly defaults: LiquidAuthChannelProviderOptions = {}) {}

  async startPairing(opts: Ac2StartPairingOptions = {}): Promise<Ac2PairingHandle> {
    opts.signal?.throwIfAborted();
    await ensureWebRtcPolyfill();

    const origin = this.defaults.origin ?? 'https://debug.liquidauth.com';
    const invitationPromise = this.defaults.pairing
      ? Promise.resolve(this.defaults.pairing)
      : createPairingInvitation(origin, this.defaults.requestId, opts.signal);
    const durablePairing = await waitForPairingPhase(invitationPromise, opts, 'pairing invitation');
    const requestId = durablePairing.pairingId;
    const includeStream = this.defaults.includeStreamChannel ?? true;
    const heartbeatTimeoutMs = resolveHeartbeatTimeoutMs(
      this.defaults.heartbeatTimeoutMs ?? process.env['AC2_HEARTBEAT_TIMEOUT_MS'],
    );

    // Build the signaling socket from the Node-native `socket.io-client` and
    // pass it to `SignalClient` via its `{ socket }` option.
    const socket = createSocketIoClient(origin, buildSignalingSocketOptions(durablePairing));

    const client = new SignalClient(origin, { socket: socket as any });

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let controlChannel: any;
    let streamChannel: any;
    let heartbeatChannel: any;
    let lastHeartbeatInboundAt = Date.now();
    let emitTransportClose: () => void = () => {};
    let closed = false;

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      closeRtcDataChannel(heartbeatChannel);
      closeRtcDataChannel(streamChannel);
      closeRtcDataChannel(controlChannel);
      emitTransportClose();
      try {
        (client as unknown as { peerClient?: { close?: () => void } }).peerClient?.close?.();
      } catch {
        // Already closed; ignore.
      }
      try {
        client.close(true);
      } catch {
        // Already closed; ignore.
      }
    };

    const onAbort = (): void => {
      void close();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // Capture the wallet account from the Liquid Auth `link` response.
    let linkedWallet: string | undefined;
    client.on('link-message', (data: { wallet?: string; credId?: string } | undefined) => {
      if (data && typeof data.wallet === 'string' && data.wallet.length > 0) {
        linkedWallet = data.wallet;
      }
    });

    // Block resolving until the signaling socket is up (the caller renders
    // the QR only after `startPairing` resolves).
    const waitForConnect = waitForSignalingConnect(socket as unknown as SignalingSocketLike);
    // Bind low-level error/disconnect diagnostics once the socket is built.
    void (async () => {
      try {
        const internal = client as unknown as { _socketPromise?: Promise<void>; socket?: any };
        if (internal._socketPromise) await internal._socketPromise;
        const sock = internal.socket;
        if (sock && typeof sock.on === 'function') {
          sock.on('connect_error', (err: any) => {
            const description =
              err?.description !== undefined ? ` description=${String(err.description)}` : '';
            const ctxStatus =
              err?.context?.status !== undefined ? ` status=${String(err.context.status)}` : '';
            // eslint-disable-next-line no-console
            console.error(
              `[ac2] Signaling socket connect_error: ${err?.message ?? err}${description}${ctxStatus}`,
            );
          });
          sock.on('disconnect', (reason: unknown, details: unknown) => {
            const extra = details ? ` details=${JSON.stringify(details)}` : '';
            // eslint-disable-next-line no-console
            console.error(`[ac2] Signaling socket disconnect reason: ${String(reason)}${extra}`);
          });
          const engine = sock.io?.engine;
          if (engine && typeof engine.on === 'function') {
            engine.on('close', (reason: unknown) =>
              // eslint-disable-next-line no-console
              console.error(`[ac2] Signaling engine closed: ${String(reason)}`),
            );
          }
          if (sock.io && typeof sock.io.on === 'function') {
            sock.io.on('error', (err: Error) =>
              // eslint-disable-next-line no-console
              console.error(`[ac2] Signaling manager error: ${err?.message ?? err}`),
            );
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[ac2] Failed to initialize signaling socket: ${(err as Error).message}`);
      }
    })();

    const qrPayload: string = client.deepLink(requestId);

    const pairing: Ac2PairingInfo = {
      qrPayload,
      metadata: { origin, requestId, pairing: durablePairing },
    };

    const connect = async (): Promise<Ac2PairedChannel> => {
      // `peer(...)` resolves with the primary channel; the rest arrive via `'data-channel'`.
      client.on('data-channel', (channel: any) => {
        if (channel.label === AC2_CONTROL_LABEL) controlChannel = channel;
        else if (channel.label === AC2_STREAM_LABEL) streamChannel = channel;
        else if (channel.label === AC2_HEARTBEAT_LABEL) {
          heartbeatChannel = channel;
          lastHeartbeatInboundAt = Date.now();
          // Side channels may arrive after `peer()` resolves its first channel.
          // Wire the responder here rather than after the connection grace
          // period so a late heartbeat channel can never miss its handler.
          attachHeartbeatResponder(channel, () => {
            lastHeartbeatInboundAt = Date.now();
          });
        }
      });

      type DataChannelInit = { ordered?: boolean };
      const dataChannels: Record<string, DataChannelInit> = {
        [AC2_CONTROL_LABEL]: { ordered: true },
        ...(includeStream ? { [AC2_STREAM_LABEL]: { ordered: true } } : {}),
        [AC2_HEARTBEAT_LABEL]: { ordered: true },
      };
      const peerPromise: Promise<any> = (
        client.peer as unknown as (
          requestId: string,
          type: 'offer',
          config: any,
          options: Record<string, unknown>,
        ) => Promise<any>
      )(requestId, 'offer', AC2_ICE_CONFIG, {
        dataChannels,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      const primary: any = await waitForPairingPhase(peerPromise, opts, 'peer connection');
      controlChannel = controlChannel ?? primary;

      if (controlChannel.label !== AC2_CONTROL_LABEL) {
        throw new Error(
          `[ac2-open-claw] Expected control channel labeled "${AC2_CONTROL_LABEL}", got "${controlChannel.label}". ` +
          `The Controller app must use the latest liquid-auth-js with ac2-v1 support.`,
        );
      }

      // Brief grace period so the app attaches handlers before resolve.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const { transport, emitClose } = closeAwareTransport(rtcDataChannelTransport(controlChannel));
      emitTransportClose = emitClose;

      if (!transport.isOpen) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Timeout waiting for DataChannel to open')),
            10000,
          );
          transport.onOpen(() => {
            clearTimeout(timeout);
            resolve();
          });
          transport.onError((err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
      }

      // Bidirectional keep-alive: each side pings on its own timer AND replies
      // PONG to the peer's pings. `lastInboundAt` is updated on any inbound
      // frame (PING or PONG). If an operator explicitly configures
      // `heartbeatTimeoutMs`, the interval below closes on expiry.
      //
      // The timeout is disabled by default because mobile controllers can
      // suspend JavaScript in the background while native WebRTC remains valid.
      // WebRTC/control close handlers remain authoritative for peers that
      // really go away.
      lastHeartbeatInboundAt = Date.now();
      heartbeat = setInterval(() => {
        if (!heartbeatChannel || heartbeatChannel.readyState !== 'open') return;

        if (
          heartbeatTimeoutMs !== undefined &&
          Date.now() - lastHeartbeatInboundAt > heartbeatTimeoutMs
        ) {
          // eslint-disable-next-line no-console
          console.warn(
            `[ac2] Heartbeat timeout (${heartbeatTimeoutMs}ms with no inbound) — closing channel.`,
          );
          void close();
          return;
        }
        try {
          if (heartbeatChannel && heartbeatChannel.readyState === 'open') {
            heartbeatChannel.send(AC2_HEARTBEAT_PING);
          }
        } catch {
          // Channel closed between checks; ignore.
        }
      }, AC2_HEARTBEAT_MS);

      const channel: Ac2PairedChannel = {
        transport,
        ...(streamChannel !== undefined ? { streamChannel } : {}),
        // Heartbeat is intentionally out-of-band: the `ac2-heartbeat`
        // DataChannel is still negotiated and pinged inside this provider
        // (see the `setInterval` above) for liveness, but it is NOT exposed
        // on the returned `Ac2PairedChannel`. Consumers that need to detect
        // a dead peer should rely on the control transport's `onClose` /
        // signaling-engine close events rather than a dedicated channel —
        // and the SDK's public `Ac2PairedChannel` shape stays in sync with
        // `@algorandfoundation/ac2-sdk` (no `heartbeatChannel?` field).
        // Bind the real connected wallet (normalized to canonical `did:key:z…`).
        ...(linkedWallet !== undefined
          ? {
            peer: {
              did: normalizeDidKey(`did:key:${linkedWallet}`),
              wallet: linkedWallet,
            },
          }
          : {}),
        close,
      };
      return channel;
    };

    try {
      await waitForPairingPhase(waitForConnect, opts, 'signaling connection');
    } catch (error) {
      await close();
      throw error;
    }

    return {
      pairing,
      connect: async () => {
        try {
          return await connect();
        } catch (error) {
          await close();
          throw error;
        }
      },
    };
  }
}
