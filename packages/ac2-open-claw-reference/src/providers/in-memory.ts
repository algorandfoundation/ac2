/** In-memory `Ac2ChannelProvider` for tests — no signaling server. */

import type {
  Ac2ChannelProvider,
  Ac2PairedChannel,
  Ac2PairingHandle,
  Ac2PairingInfo,
  Ac2StartPairingOptions,
} from '@algorandfoundation/ac2-sdk/signaling';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';
import { createInMemoryTransportPair } from '@algorandfoundation/ac2-sdk/transport';

export interface InMemoryChannelProviderOptions {
  /** Override origin used to synthesise the QR payload. */
  origin?: string;
  /** Pre-supplied requestId; otherwise a random UUID. */
  requestId?: string;
}

export class InMemoryChannelProvider implements Ac2ChannelProvider {
  /** Peer end of the last in-memory transport pair (test stand-in). */
  lastPeerTransport: Ac2Transport | undefined;

  constructor(private readonly defaults: InMemoryChannelProviderOptions = {}) {}

  async startPairing(_opts: Ac2StartPairingOptions = {}): Promise<Ac2PairingHandle> {
    const origin = this.defaults.origin ?? 'https://debug.liquidauth.com';
    const requestId = this.defaults.requestId ?? crypto.randomUUID();
    const url = new URL(origin);
    const hostPath = (url.host + url.pathname).replace(/\/$/, '');
    const qrPayload = `liquid://${hostPath}?requestId=${encodeURIComponent(requestId)}`;
    const pairing: Ac2PairingInfo = {
      qrPayload,
      metadata: { origin, requestId },
    };

    const [agentTransport, peerTransport] = createInMemoryTransportPair();
    this.lastPeerTransport = peerTransport;

    this.onPairingPrepared(peerTransport, pairing);

    const connect = async (): Promise<Ac2PairedChannel> => {
      return {
        transport: agentTransport,
        close: async () => {
          agentTransport.close();
          peerTransport.close();
        },
      };
    };

    return { pairing, connect };
  }

  /** Subclass hook — attach controller-side behaviour before `connect()`. */
  protected onPairingPrepared(_peerTransport: Ac2Transport, _pairing: Ac2PairingInfo): void {
    // no-op by default
  }
}
