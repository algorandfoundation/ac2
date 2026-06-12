/** The `ac2` `ChannelPlugin` registered via `api.registerChannel(...)`. */

import type { ChannelPlugin } from 'openclaw/plugin-sdk';

import { CHANNEL_ID } from '../runtime.js';
import { sessionManager } from '../session/index.js';
import { AC2_CHANNEL_ENV_VARS } from '../setup/config.js';
import {
  AC2_DEFAULT_ACK_POLICY,
  AC2_DURABLE_FINAL_CAPABILITIES,
  AC2_LIVE_CAPABILITIES,
  AC2_LIVE_FINALIZER_CAPABILITIES,
  AC2_SUPPORTED_ACK_POLICIES,
  buildAc2MessageReceipt,
  defineAc2MessageAdapter,
  type MessageReceipt,
} from './message-adapter.js';
import { sendDiscard, sendPreview } from './stream.js';
import {
  getActiveConversation,
  resolveAc2OutboundSessionRoute,
  resolveAc2SessionConversation,
  type Ac2OutboundSessionRoute,
  type Ac2SessionConversation,
} from './conversation.js';

/** Media-source param map for the message tool's `describeMessageTool`. */
export type Ac2MediaSourceParams = Readonly<Record<string, readonly string[]>>;

export const AC2_MEDIA_SOURCE_PARAMS: Ac2MediaSourceParams = {
  send: ['mediaUrl', 'mediaPath'],
  'share-artifact': ['artifactUrl', 'artifactPath'],
  'share-qr': ['qrUrl', 'qrPath'],
};

/** Drive the heartbeat typing indicator over the live-preview protocol. */
function emitHeartbeatPresence(
  kind: 'typing' | 'clear',
  target?: { to?: { conversationId?: string } },
): void {
  const active = sessionManager.getActive();
  if (!active) return;
  const conversationId = target?.to?.conversationId;
  if (conversationId && conversationId !== active.controllerDid) return;
  const thid = getActiveConversation(active.controllerDid, active.requestId);
  if (kind === 'typing') sendPreview(active.transport, thid, 'typing');
  else sendDiscard(active.transport, thid);
}

export function buildChannelObject(): ChannelPlugin {
  const channel = {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: 'AC2',
      selectionLabel: 'AC2 (Liquid Auth + WebRTC)',
      blurb:
        'Pair an AC2 Controller / wallet over Liquid Auth + WebRTC DataChannels. `ac2_sign` and `ac2_capabilities` route through the active session.',
      docsPath: '/channels/ac2',
      aliases: [],
      order: 100,
    },
    capabilities: {
      chatTypes: ['direct'],
      features: ['text'],
    },
    channelEnvVars: AC2_CHANNEL_ENV_VARS,
    config: {
      listAccountIds: (): string[] => {
        const active = sessionManager.getActive();
        return active ? [active.controllerDid] : [];
      },
      resolveAccount: (
        _cfg: unknown,
        accountId?: string | null,
      ): { accountId: string | null; config: Record<string, unknown> } => {
        const active = sessionManager.getActive();
        if (
          active &&
          (accountId === undefined || accountId === null || accountId === active.controllerDid)
        ) {
          return {
            accountId: active.controllerDid,
            config: { peerDid: active.controllerDid },
          };
        }
        return { accountId: accountId ?? null, config: {} };
      },
      inspectAccount: (_cfg: unknown, accountId?: string | null): unknown => {
        const active = sessionManager.getActive();
        if (
          !active ||
          (accountId !== undefined && accountId !== null && accountId !== active.controllerDid)
        ) {
          return null;
        }
        return {
          peerDid: active.controllerDid,
          paired: true,
          online: true,
        };
      },
    },
    outbound: {
      attachedResults: {
        async sendText({
          to,
          text,
        }: {
          to: { conversationId: string };
          text: string;
        }): Promise<{ messageId: string }> {
          const active = sessionManager.requireActive();
          if (to.conversationId && active.controllerDid !== to.conversationId) {
            throw new Error(
              `[${CHANNEL_ID}] conversationId ${to.conversationId} does not match active peer ${active.controllerDid}`,
            );
          }
          if (active.transport.isOpen) {
            active.transport.send(text);
          }
          return { messageId: `ac2-${Date.now()}` };
        },
      },
    },
    heartbeat: {
      sendTyping: (target?: { to?: { conversationId?: string } }): void => {
        emitHeartbeatPresence('typing', target);
      },
      clearTyping: (target?: { to?: { conversationId?: string } }): void => {
        emitHeartbeatPresence('clear', target);
      },
    },
    messaging: {
      resolveSessionConversation: (rawId: string): Ac2SessionConversation =>
        resolveAc2SessionConversation(rawId),
      resolveOutboundSessionRoute: (params: {
        agentId?: string;
        target: string;
        threadId?: string | number | null;
      }): Ac2OutboundSessionRoute => {
        const active = sessionManager.getActive();
        return resolveAc2OutboundSessionRoute({
          target: params.target,
          from: active?.agentDid ?? params.agentId ?? params.target,
          ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
        });
      },
    },
    message: defineAc2MessageAdapter({
      id: CHANNEL_ID,
      durableFinal: {
        capabilities: { ...AC2_DURABLE_FINAL_CAPABILITIES },
      },
      send: {
        text: async (ctx: { to: string; text: string }): Promise<{ receipt: MessageReceipt }> => {
          const active = sessionManager.requireActive();
          if (ctx.to && active.controllerDid !== ctx.to) {
            throw new Error(
              `[${CHANNEL_ID}] target ${ctx.to} does not match active peer ${active.controllerDid}`,
            );
          }
          const messageId = `ac2-${Date.now()}`;
          if (active.transport.isOpen) active.transport.send(ctx.text);
          return {
            receipt: buildAc2MessageReceipt(messageId, active.controllerDid),
          };
        },
      },
      live: {
        capabilities: { ...AC2_LIVE_CAPABILITIES },
        finalizer: {
          capabilities: { ...AC2_LIVE_FINALIZER_CAPABILITIES },
        },
      },
      receive: {
        defaultAckPolicy: AC2_DEFAULT_ACK_POLICY,
        supportedAckPolicies: [...AC2_SUPPORTED_ACK_POLICIES],
      },
    }),
    describeMessageTool: (_descriptor?: unknown): { mediaSourceParams: Ac2MediaSourceParams } => ({
      mediaSourceParams: AC2_MEDIA_SOURCE_PARAMS,
    }),
  };
  return channel as unknown as ChannelPlugin;
}
