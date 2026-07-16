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
/**
 * Treat the peer as gone if we receive no `ac2-heartbeat` traffic for this
 * long. 2.5× the send interval tolerates one missed round-trip plus jitter.
 */
const AC2_DEFAULT_HEARTBEAT_TIMEOUT_MS = AC2_HEARTBEAT_MS * 2.5;
/** Default ceiling for awaiting the signaling socket's initial `connect`. */
const AC2_DEFAULT_PAIRING_TIMEOUT_MS = 120_000;
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

export function resolveHeartbeatTimeoutMs(value?: string): number {
  if (value === undefined || value.trim().length === 0) return AC2_DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const parsed = Number(value);
  const minimum = AC2_HEARTBEAT_MS * 2;
  return Number.isFinite(parsed) && parsed >= minimum
    ? parsed
    : AC2_DEFAULT_HEARTBEAT_TIMEOUT_MS;
}

/** Raised when the signaling socket never reaches `connect` in time. */
export class SignalingConnectError extends Error {
  readonly code: 'timeout' | 'aborted';
  constructor(code: 'timeout' | 'aborted', message: string) {
    super(message);
    this.name = 'SignalingConnectError';
    this.code = code;
  }
}

/**
 * Await the signaling socket's first `connect`, bounded by `timeoutMs` and an
 * optional abort `signal`. On timeout or abort, invokes `onFailure` (used to
 * tear down the socket so it stops retrying) and rejects — so callers never
 * block forever on an unreachable signaling server. A successful `connect`
 * clears the timer and detaches the abort listener; later duplicate `connect`
 * events (or an elapsed timer) are no-ops.
 */
export function awaitSignalConnect(
  client: { on: (event: string, listener: (...args: any[]) => void) => void },
  opts: { timeoutMs: number; signal?: AbortSignal; onFailure?: () => void },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const fail = (error: SignalingConnectError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        opts.onFailure?.();
      } catch {
        // Teardown is best-effort; still reject the caller.
      }
      reject(error);
    };

    function onAbort(): void {
      fail(
        new SignalingConnectError(
          'aborted',
          '[ac2-open-claw] pairing aborted before the signaling socket connected',
        ),
      );
    }

    if (opts.signal?.aborted) {
      onAbort();
      return;
    }

    client.on('connect', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    });

    opts.signal?.addEventListener('abort', onAbort);

    if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(
          new SignalingConnectError(
            'timeout',
            `[ac2-open-claw] signaling socket did not connect within ${opts.timeoutMs}ms`,
          ),
        );
      }, opts.timeoutMs);
    }
  });
}

/**
 * Race an arbitrary pairing-handshake promise against `timeoutMs` and an
 * optional abort `signal`. Used to bound the ICE offer/answer/candidate
 * exchange (`SignalClient#peer`), which depends on the signaling socket
 * staying alive for its whole duration — if that socket dies mid-handshake
 * (e.g. a `ping timeout`) and never reconnects, the underlying promise would
 * otherwise never settle. On timeout/abort, invokes `onFailure` (torn down
 * once) and rejects; a later resolution/rejection of `promise` itself is
 * ignored once the bound has already tripped.
 */
export function withPairingTimeout<T>(
  promise: Promise<T>,
  opts: { timeoutMs: number; signal?: AbortSignal; onFailure?: () => void },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const fail = (error: SignalingConnectError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        opts.onFailure?.();
      } catch {
        // Teardown is best-effort; still reject the caller.
      }
      reject(error);
    };

    function onAbort(): void {
      fail(
        new SignalingConnectError(
          'aborted',
          '[ac2-open-claw] pairing aborted before the handshake completed',
        ),
      );
    }

    if (opts.signal?.aborted) {
      onAbort();
      return;
    }

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );

    opts.signal?.addEventListener('abort', onAbort);

    if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(
          new SignalingConnectError(
            'timeout',
            `[ac2-open-claw] pairing handshake did not complete within ${opts.timeoutMs}ms`,
          ),
        );
      }, opts.timeoutMs);
    }
  });
}

export interface LiquidAuthChannelProviderOptions {
  /** Liquid Auth signaling server origin. */
  origin?: string;
  /** Pre-supplied requestId (otherwise `SignalClient.generateRequestId()`). */
  requestId?: string;
  /** Request the optional `ac2-stream` channel (default `true`). */
  includeStreamChannel?: boolean;
  /** Milliseconds without inbound heartbeat traffic before closing. */
  heartbeatTimeoutMs?: number;
}

export class LiquidAuthChannelProvider implements Ac2ChannelProvider {
  constructor(private readonly defaults: LiquidAuthChannelProviderOptions = {}) {}

  async startPairing(opts: Ac2StartPairingOptions = {}): Promise<Ac2PairingHandle> {
    await ensureWebRtcPolyfill();

    const origin = this.defaults.origin ?? 'https://debug.liquidauth.com';
    const requestId = this.defaults.requestId ?? SignalClient.generateRequestId();
    const includeStream = this.defaults.includeStreamChannel ?? true;
    const heartbeatTimeoutMs =
      this.defaults.heartbeatTimeoutMs ??
      resolveHeartbeatTimeoutMs(process.env['AC2_HEARTBEAT_TIMEOUT_MS']);

    // Build the signaling socket from the Node-native `socket.io-client` and
    // pass it to `SignalClient` via its `{ socket }` option.
    const socket = createSocketIoClient(origin, {
      autoConnect: true,
    });

    const client = new SignalClient(origin, { socket: socket as any });

    // Capture the wallet account from the Liquid Auth `link` response.
    let linkedWallet: string | undefined;
    client.on('link-message', (data: { wallet?: string; credId?: string } | undefined) => {
      if (data && typeof data.wallet === 'string' && data.wallet.length > 0) {
        linkedWallet = data.wallet;
      }
    });

    // Shared ceiling for both the initial socket connect and the subsequent
    // ICE offer/answer/candidate exchange in `connect()` — both phases depend
    // on the same signaling socket staying alive.
    const pairingTimeoutMs = opts.timeoutMs ?? AC2_DEFAULT_PAIRING_TIMEOUT_MS;

    // Block resolving until the signaling socket is up (the caller renders
    // the QR only after `startPairing` resolves). Bounded by `timeoutMs` and
    // the caller's abort signal so an unreachable signaling server rejects
    // instead of hanging the re-pairing loop forever — and the failing socket
    // is torn down so it stops emitting reconnect/ping-timeout noise.
    const waitForConnect = awaitSignalConnect(client, {
      timeoutMs: pairingTimeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      onFailure: () => {
        try {
          client.close(true);
        } catch {
          // Already closed; ignore.
        }
        try {
          (socket as { close?: () => void }).close?.();
        } catch {
          // Already closed; ignore.
        }
      },
    });
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
      metadata: { origin, requestId },
    };

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    // Forward-declare so the heartbeat interval (defined inside `connect`)
    // can call it on liveness timeout.
    let close: () => Promise<void> = async () => {
      /* assigned in connect() */
    };

    const connect = async (): Promise<Ac2PairedChannel> => {
      // `peer(...)` resolves with the primary channel; the rest arrive via `'data-channel'`.
      let controlChannel: any;
      let streamChannel: any;
      let heartbeatChannel: any;
      client.on('data-channel', (channel: any) => {
        if (channel.label === AC2_CONTROL_LABEL) controlChannel = channel;
        else if (channel.label === AC2_STREAM_LABEL) streamChannel = channel;
        else if (channel.label === AC2_HEARTBEAT_LABEL) heartbeatChannel = channel;
      });

      type DataChannelInit = { ordered?: boolean };
      const dataChannels: Record<string, DataChannelInit> = {
        [AC2_CONTROL_LABEL]: { ordered: true },
        ...(includeStream ? { [AC2_STREAM_LABEL]: { ordered: true } } : {}),
        [AC2_HEARTBEAT_LABEL]: { ordered: true },
      };
      // Bounded the same way as the initial socket connect: `peer(...)`'s
      // offer/answer/candidate exchange depends on the signaling socket for
      // its whole duration, and has no timeout of its own — if the socket
      // dies mid-handshake (e.g. a `ping timeout`) and never reconnects, this
      // would otherwise hang forever waiting for data that will never arrive.
      const primary: any = await withPairingTimeout(
        client.peer(requestId, 'offer', AC2_ICE_CONFIG, { dataChannels }),
        {
          timeoutMs: pairingTimeoutMs,
          ...(opts.signal ? { signal: opts.signal } : {}),
          onFailure: () => {
            try {
              (client as any).peerClient?.close?.();
            } catch {
              // Best-effort cleanup.
            }
            try {
              client.close(true);
            } catch {
              // Already closed; ignore.
            }
            try {
              (socket as { close?: () => void }).close?.();
            } catch {
              // Already closed; ignore.
            }
          },
        },
      );
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
      // frame (PING or PONG); the interval below declares the peer dead if no
      // inbound traffic arrives within `heartbeatTimeoutMs` and triggers
      // `close()` so the control transport's `onClose` propagates upstream.
      //
      // The heartbeat channel is optional and mobile controllers can suspend
      // it while backgrounded. Only enforce the timeout when the heartbeat
      // channel is present and open; the WebRTC/control close handlers remain
      // authoritative for peers that really go away.
      let lastInboundAt = Date.now();

      if (heartbeatChannel) {
        heartbeatChannel.onmessage = (ev: { data: unknown }) => {
          lastInboundAt = Date.now();
          if (ev?.data === AC2_HEARTBEAT_PING && heartbeatChannel.readyState === 'open') {
            try {
              heartbeatChannel.send(AC2_HEARTBEAT_PONG);
            } catch {
              // Channel closing between check and send; ignore.
            }
          }
        };
      }

      heartbeat = setInterval(() => {
        if (!heartbeatChannel || heartbeatChannel.readyState !== 'open') return;

        if (Date.now() - lastInboundAt > heartbeatTimeoutMs) {
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

      close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
        closeRtcDataChannel(heartbeatChannel);
        closeRtcDataChannel(streamChannel);
        closeRtcDataChannel(controlChannel);
        emitClose();
        try {
          client.close(true);
        } catch {
          // Already closed; ignore.
        }
      };

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

    await waitForConnect;

    return { pairing, connect };
  }
}
