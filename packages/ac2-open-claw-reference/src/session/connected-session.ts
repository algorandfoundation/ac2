/** One connected AC2 session, shared by the gateway supervisor and legacy CLI. */

import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { isValidAddress } from '@algorandfoundation/algokit-utils/common';
import type { Ac2PairedChannel } from '@algorandfoundation/ac2-sdk/signaling';
import type { OpenClawApi, ResolvedConfig } from '../runtime.js';
import { safeLog } from '../runtime.js';
import { BootstrapError, bootstrapAgentIdentity } from './bootstrap.js';
import { sessionManager } from './manager.js';
import {
  ensureConversation,
  loadAc2State,
  saveAc2State,
  setConnectionIdentity,
  touchConnection,
} from '../identity/state.js';
import { normalizeDidKey } from '../identity/did.js';
import { hasAgentIdentity, recordAgentIdentity } from '../identity/keystore.js';
import {
  DEFAULT_THID,
  clearActiveConversation,
  replayConversationHistory,
  replayConversationList,
  routeInboundToAgent,
  sendFinalize,
  setActiveConversation,
} from '../channel/index.js';

const NO_IDENTITY_NOTICE =
  "I don't have an identity yet. To work with you securely I need my own " +
  'dedicated key. Until you grant one, I can chat with you but cannot perform signing-related actions.';

export interface ConnectedSessionOptions {
  api: OpenClawApi;
  config: ResolvedConfig;
  connect: () => Promise<Ac2PairedChannel>;
  /** Pairing id for this exact attempt; avoids reading a concurrently replaced state record. */
  requestId?: string;
  signal?: AbortSignal;
  onState?: (state: 'online' | 'offline') => void;
}

/** Connect, restore/bootstrap identity, route messages, and wait for transport loss. */
export async function runConnectedSession(options: ConnectedSessionOptions): Promise<void> {
  const { api, config, connect, signal, onState } = options;
  let paired: Ac2PairedChannel | undefined;
  try {
    signal?.throwIfAborted();
    const connected = await connect();
    paired = connected;
    const { transport, streamChannel: streamTransport } = connected;
    const client = new Ac2Client(transport);

    const state = loadAc2State();
    const connectionRequestId = options.requestId ?? state.pairing?.pairingId ?? state.requestId;
    if (connectionRequestId) touchConnection(connectionRequestId);

    const connectedAccount =
      typeof connected.peer?.['wallet'] === 'string'
        ? (connected.peer['wallet'] as string)
        : undefined;
    const walletAddress =
      connectedAccount !== undefined && isValidAddress(connectedAccount)
        ? connectedAccount
        : undefined;
    const connectedAccountDid =
      connectedAccount !== undefined
        ? normalizeDidKey(`did:key:${connectedAccount}`)
        : connected.peer?.did;
    const storedIdentity =
      (connectionRequestId
        ? loadAc2State().connections?.[connectionRequestId]?.identity
        : undefined) ?? loadAc2State().identity;

    let agentDid = 'did:ac2:agent';
    let controllerDid = connectedAccountDid ?? 'did:key:zAc2Controller';
    let identityGranted = true;
    if (storedIdentity) {
      if (
        connectedAccountDid !== undefined &&
        storedIdentity.controllerDid !== connectedAccountDid
      ) {
        throw new BootstrapError(
          `[ac2-open-claw] Persisted controller (${storedIdentity.controllerDid}) does not match ` +
            `the linked account (${connectedAccountDid}); refusing the reconnect.`,
        );
      }
      agentDid = storedIdentity.agentDid;
      controllerDid = storedIdentity.controllerDid;
      if (storedIdentity.material && !hasAgentIdentity(agentDid)) {
        await recordAgentIdentity({
          agentDid,
          publicKey: storedIdentity.publicKey,
          material: storedIdentity.material,
        });
      }
      safeLog(api, 'info', '[ac2] Reusing persisted agent identity.');
    } else {
      let bootstrapped: Awaited<ReturnType<typeof bootstrapAgentIdentity>> | undefined;
      try {
        bootstrapped = await bootstrapAgentIdentity(client, {
          ...(connected.peer?.did !== undefined ? { peerDid: connected.peer.did } : {}),
          ...(config.defaultTimeoutMs !== undefined
            ? { timeoutMs: config.defaultTimeoutMs }
            : {}),
        });
      } catch (error) {
        if (!(error instanceof BootstrapError)) throw error;
        identityGranted = false;
        safeLog(
          api,
          'warn',
          `[ac2] No agent identity granted: ${error.message}. Keeping chat available.`,
        );
      }
      if (bootstrapped) {
        agentDid = bootstrapped.agentDid;
        if (
          connectedAccountDid !== undefined &&
          bootstrapped.controllerDid !== connectedAccountDid
        ) {
          throw new BootstrapError(
            `[ac2-open-claw] KeyResponse.from (${bootstrapped.controllerDid}) does not match ` +
              `the linked account (${connectedAccountDid}); refusing to grant identity.`,
          );
        }
        controllerDid = connectedAccountDid ?? bootstrapped.controllerDid;
        if (bootstrapped.response.body.material !== undefined) {
          await recordAgentIdentity({
            agentDid,
            publicKey: bootstrapped.response.body.public_key,
            material: bootstrapped.response.body.material,
          });
        }
        const identity = {
          agentDid,
          controllerDid,
          publicKey: bootstrapped.response.body.public_key,
        };
        if (connectionRequestId) setConnectionIdentity(connectionRequestId, identity);
        else saveAc2State({ identity });
      }
    }

    sessionManager.setActive({
      transport,
      client,
      controllerDid,
      agentDid,
      identityGranted,
      ...(walletAddress ? { walletAddress } : {}),
      ...(connectionRequestId ? { requestId: connectionRequestId } : {}),
    });
    safeLog(
      api,
      'info',
      `[ac2] Channel paired and active. agentDid=${agentDid} controllerDid=${controllerDid}`,
    );
    onState?.('online');

    const streamSendable = streamTransport
      ? {
          send: (payload: string) => streamTransport.send(payload),
          get isOpen() {
            return streamTransport.readyState === 'open';
          },
        }
      : undefined;
    const controlSendable = {
      send(payload: string): void {
        if (streamSendable?.isOpen) {
          try {
            streamSendable.send(payload);
            return;
          } catch {
            // The stream can close between readyState and send; fall back to control.
          }
        }
        transport.send(payload);
      },
      get isOpen() {
        return Boolean(streamSendable?.isOpen || transport.isOpen);
      },
    };

    client.updateHandlers({
      'ac2/ConversationOpen': (msg) => {
        const thid =
          typeof (msg.body as any)?.thid === 'string' && (msg.body as any).thid.length > 0
            ? ((msg.body as any).thid as string)
            : msg.thid;
        if (!thid) return;
        const title =
          typeof (msg.body as any)?.title === 'string'
            ? ((msg.body as any).title as string)
            : undefined;
        setActiveConversation(controllerDid, thid, connectionRequestId);
        if (connectionRequestId) {
          ensureConversation(connectionRequestId, thid, title);
        }
        replayConversationHistory(controlSendable, connectionRequestId, thid);
      },
      'ac2/ConversationClose': (msg) => {
        const thid =
          typeof (msg.body as any)?.thid === 'string' && (msg.body as any).thid.length > 0
            ? ((msg.body as any).thid as string)
            : msg.thid;
        if (thid) clearActiveConversation(controllerDid, thid, connectionRequestId);
      },
    });

    replayConversationList(controlSendable, connectionRequestId);
    replayConversationHistory(controlSendable, connectionRequestId, DEFAULT_THID);
    if (!identityGranted) {
      sendFinalize(controlSendable, DEFAULT_THID, `ac2-noid-${Date.now()}`, NO_IDENTITY_NOTICE);
    }

    if (streamTransport) {
      streamTransport.onmessage = async (event: { data: unknown }) => {
        if (typeof event.data !== 'string' || event.data.trim().length === 0) return;
        const active = sessionManager.getActive();
        if (!active) return;
        await routeInboundToAgent(
          api,
          event.data,
          controlSendable,
          active.controllerDid,
          active.requestId,
        );
      };
    }
    transport.onRawMessage?.(async (text: string) => {
      const active = sessionManager.getActive();
      if (!active) return;
      await routeInboundToAgent(
        api,
        text,
        controlSendable,
        active.controllerDid,
        active.requestId,
      );
    });

    await new Promise<void>((resolve) => {
      transport.onClose(resolve);
      transport.onError(() => resolve());
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    onState?.('offline');
    sessionManager.clearActive();
    if (paired) await paired.close();
  }
}
