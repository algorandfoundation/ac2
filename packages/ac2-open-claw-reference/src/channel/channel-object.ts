/** The `ac2` `ChannelPlugin` registered via `api.registerChannel(...)`. */

import type { ChannelPlugin } from 'openclaw/plugin-sdk';

import { CHANNEL_ID } from '../runtime.js';
import { sessionManager } from '../session/manager.js';
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
import { sendDiscard, sendFinalize, sendPreview } from './stream.js';
import {
  DEFAULT_THID,
  getActiveConversation,
  resolveAc2OutboundSessionRoute,
  resolveAc2SessionConversation,
  type Ac2OutboundSessionRoute,
  type Ac2SessionConversation,
} from './conversation.js';
import { recordConversationMessage } from '../identity/state.js';
import { findPendingTaskForParent, markTaskResult } from './tasks.js';

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

/**
 * Resolve the wallet `thid` for a host-initiated outbound send. `threadId` is
 * whatever `messaging.resolveOutboundSessionRoute` produced (normally a plain
 * `thid`); tolerate a full `ac2:<did>:<thid>` session key too, and fall back to
 * the connection's active conversation.
 */
function resolveOutboundThid(threadId: unknown): string {
  if (typeof threadId === 'string' && threadId.length > 0) {
    if (threadId.includes(':')) {
      return resolveAc2SessionConversation(threadId).threadId ?? DEFAULT_THID;
    }
    return threadId;
  }
  if (typeof threadId === 'number') return String(threadId);
  const active = sessionManager.getActive();
  return active ? getActiveConversation(active.controllerDid, active.requestId) : DEFAULT_THID;
}

/**
 * Deliver an agent-initiated (host-driven) text message to the wallet.
 *
 * Unlike the per-turn streaming reply (which the agent finalizes itself over
 * the control channel in `routing.ts`), this path handles messages the host
 * pushes through the channel adapters — most importantly **sub-agent completion
 * announces**, which arrive as a fresh `agent` turn targeting the requester
 * session. When a control (stream) transport is available we emit a proper
 * thread-scoped `finalize` frame so the reply renders in the right conversation
 * (previously these were written as raw, thread-less text and were effectively
 * lost). We also persist the message and, best-effort, flip the matching
 * background task to `completed` and mirror the result into its `task-…` thread.
 *
 * Falls back to a raw transport write when no control channel was negotiated,
 * preserving the plain-text contract for stream-unaware wallets.
 */
function deliverAgentText(params: { to?: string; text: string; threadId?: unknown }): string {
  const active = sessionManager.requireActive();
  if (params.to && active.controllerDid !== params.to) {
    throw new Error(
      `[${CHANNEL_ID}] target ${params.to} does not match active peer ${active.controllerDid}`,
    );
  }
  const thid = resolveOutboundThid(params.threadId);
  const messageId = `ac2-${Date.now()}`;
  const control = active.controlTransport;
  if (control && control.isOpen) {
    sendFinalize(control, thid, messageId, params.text);
  } else if (active.transport.isOpen) {
    active.transport.send(params.text);
  }
  if (active.requestId) {
    recordConversationMessage(active.requestId, thid, {
      role: 'agent',
      text: params.text,
      at: Date.now(),
    });
  }
  // Scope A (no native thread binding yet): the host delivers a child's
  // completion announce to the parent/requester thread. If that thread has a
  // pending task, treat this as its result — mark it done and mirror the text
  // into the task's own `task-…` thread.
  const pending = findPendingTaskForParent(thid);
  if (pending) {
    markTaskResult(pending.taskThid, 'completed', params.text);
    if (active.requestId) {
      recordConversationMessage(active.requestId, pending.taskThid, {
        role: 'agent',
        text: params.text,
        at: Date.now(),
      });
    }
  }
  return messageId;
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
          threadId,
        }: {
          to: { conversationId: string };
          text: string;
          threadId?: string | number | null;
        }): Promise<{ messageId: string }> {
          const messageId = deliverAgentText({
            ...(to?.conversationId ? { to: to.conversationId } : {}),
            text,
            threadId,
          });
          return { messageId };
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
        text: async (ctx: {
          to: string;
          text: string;
          threadId?: string | number | null;
        }): Promise<{ receipt: MessageReceipt }> => {
          const messageId = deliverAgentText({
            ...(ctx.to ? { to: ctx.to } : {}),
            text: ctx.text,
            threadId: ctx.threadId,
          });
          return {
            receipt: buildAc2MessageReceipt(messageId, sessionManager.requireActive().controllerDid),
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
