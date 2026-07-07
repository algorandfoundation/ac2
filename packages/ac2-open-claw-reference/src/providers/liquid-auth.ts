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
import { rtcDataChannelTransport } from '@algorandfoundation/ac2-sdk/transport';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { normalizeDidKey } from '../identity/did.js';

// @ts-ignore - compiled JS in node_modules
import { SignalClient } from '@algorandfoundation/liquid-client/signal';
import { io as createSocketIoClient } from 'socket.io-client';

let webRtcPolyfillReady: Promise<void> | undefined;

const require = createRequire(import.meta.url);

function findPackageRoot(entrypoint: string): string {
  let dir = dirname(entrypoint);
  const root = parse(dir).root;
  while (dir !== root) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Could not locate package root for ${entrypoint}`);
}

function findVendorBinary(platformKey: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (dir !== root) {
    const candidate = resolve(
      dir,
      'vendor',
      'node-datachannel',
      platformKey,
      'node_datachannel.node',
    );
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    'vendor',
    'node-datachannel',
    platformKey,
    'node_datachannel.node',
  );
}

function ensureBundledNodeDataChannelBinary(): void {
  const platformKey = `${process.platform}-${process.arch}`;
  const vendorBinary = findVendorBinary(platformKey);
  const vendorDir = dirname(vendorBinary);
  const nodeDataChannelRoot = findPackageRoot(require.resolve('node-datachannel'));
  const targetBinary = resolve(
    nodeDataChannelRoot,
    'build',
    'Release',
    'node_datachannel.node',
  );

  if (!existsSync(vendorBinary)) {
    if (existsSync(targetBinary)) return;
    throw new Error(
      `AC2 does not include a libnice node-datachannel binary for ${platformKey}. ` +
        'Install the latest ac2 OpenClaw plugin canary; if this persists, this platform needs a published AC2 WebRTC artifact.',
    );
  }

  mkdirSync(dirname(targetBinary), { recursive: true });
  for (const entry of readdirSync(vendorDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    copyFileSync(resolve(vendorDir, entry.name), resolve(dirname(targetBinary), entry.name));
  }
}

async function ensureWebRtcPolyfill(): Promise<void> {
  if (typeof (globalThis as any).RTCPeerConnection !== 'undefined') return;
  webRtcPolyfillReady ??= (async () => {
    // libdatachannel: modern SCTP/DTLS Node WebRTC backend, interops with react-native-webrtc.
    // Import lazily so plugin discovery/CLI startup does not require the native binary.
    ensureBundledNodeDataChannelBinary();
    const ndc = await import('node-datachannel/polyfill');

    // Subclass node-datachannel's RTCPeerConnection to queue remote ICE candidates
    // that arrive via trickle before setRemoteDescription completes. The Liquid Auth
    // SignalClient can race between trickling candidates and the offer/answer exchange;
    // node-datachannel is stricter than browser WebRTC and throws immediately
    // ("Got a remote candidate without ICE transport") instead of buffering silently.
    class Ac2RTCPeerConnection extends (ndc as any).RTCPeerConnection {
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
    (globalThis as any).RTCIceCandidate = (ndc as any).RTCIceCandidate;
    (globalThis as any).RTCSessionDescription = (ndc as any).RTCSessionDescription;
    if ((ndc as any).RTCDataChannel) {
      (globalThis as any).RTCDataChannel = (ndc as any).RTCDataChannel;
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
const AC2_HEARTBEAT_TIMEOUT_MS = AC2_HEARTBEAT_MS * 2.5;
const AC2_CONTROL_LABEL = 'ac2-v1' as const;
const AC2_STREAM_LABEL = 'ac2-stream' as const;
/** Dedicated liveness channel — keeps keepalive off the control plane. */
const AC2_HEARTBEAT_LABEL = 'ac2-heartbeat' as const;
const AC2_HEARTBEAT_PING = 'ping' as const;
const AC2_HEARTBEAT_PONG = 'pong' as const;

export interface LiquidAuthChannelProviderOptions {
  /** Liquid Auth signaling server origin. */
  origin?: string;
  /** Pre-supplied requestId (otherwise `SignalClient.generateRequestId()`). */
  requestId?: string;
  /** Request the optional `ac2-stream` channel (default `true`). */
  includeStreamChannel?: boolean;
}

export class LiquidAuthChannelProvider implements Ac2ChannelProvider {
  constructor(private readonly defaults: LiquidAuthChannelProviderOptions = {}) {}

  async startPairing(_opts: Ac2StartPairingOptions = {}): Promise<Ac2PairingHandle> {
    await ensureWebRtcPolyfill();

    const origin = this.defaults.origin ?? 'https://debug.liquidauth.com';
    const requestId = this.defaults.requestId ?? SignalClient.generateRequestId();
    const includeStream = this.defaults.includeStreamChannel ?? true;

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

    // Block resolving until the signaling socket is up (the caller renders
    // the QR only after `startPairing` resolves).
    const waitForConnect = new Promise<void>((resolve) => {
      client.on('connect', () => resolve());
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
      const primary: any = await client.peer(requestId, 'offer', AC2_ICE_CONFIG, {
        dataChannels,
      });
      controlChannel = controlChannel ?? primary;

      if (controlChannel.label !== AC2_CONTROL_LABEL) {
        throw new Error(
          `[ac2-open-claw] Expected control channel labeled "${AC2_CONTROL_LABEL}", got "${controlChannel.label}". ` +
          `The Controller app must use the latest liquid-auth-js with ac2-v1 support.`,
        );
      }

      // Brief grace period so the app attaches handlers before resolve.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const transport = rtcDataChannelTransport(controlChannel);

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
      // inbound traffic arrives within AC2_HEARTBEAT_TIMEOUT_MS and triggers
      // `close()` so the control transport's `onClose` propagates upstream.
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
        if (Date.now() - lastInboundAt > AC2_HEARTBEAT_TIMEOUT_MS) {
          // eslint-disable-next-line no-console
          console.warn(
            `[ac2] Heartbeat timeout (${AC2_HEARTBEAT_TIMEOUT_MS}ms with no inbound) — closing channel.`,
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
