/** Conversation multiplexing: thread tracking, parsing, and replay helpers. */

import { CHANNEL_ID } from '../runtime.js';
import { listConversations } from '../identity/state.js';
import { sendStreamControl, type Sendable } from './stream.js';

export const DEFAULT_THID = 'default';

/**
 * Build the canonical OpenClaw session key for a controller + thread.
 *
 * The default thread collapses to the bare `ac2:<controllerDid>` base key, so
 * the key handed to the host on an inbound turn is byte-identical to the one
 * `resolveAc2OutboundSessionRoute` / `resolveAc2SessionConversation` resolve
 * for the same conversation. Otherwise an inbound turn on the default thread
 * would be keyed `ac2:<did>:default` while every other path (outbound sends,
 * session resolution, the persisted transcript) uses `ac2:<did>`, splitting a
 * single logical conversation across two OpenClaw sessions — so the agent
 * "forgets" the thread whenever the two keys diverge (e.g. on a reconnect).
 */
export function buildAc2SessionKey(controllerDid: string, thid?: string): string {
  const base = `${CHANNEL_ID}:${controllerDid}`;
  return thid !== undefined && thid.length > 0 && thid !== DEFAULT_THID
    ? `${base}:${thid}`
    : base;
}

const activeThreadByConnection = new Map<string, string>();

function connectionThreadKey(controllerDid: string, requestId?: string): string {
  return requestId ?? controllerDid;
}

export function setActiveConversation(
  controllerDid: string,
  thid: string,
  requestId?: string,
): void {
  activeThreadByConnection.set(connectionThreadKey(controllerDid, requestId), thid);
}

export function clearActiveConversation(
  controllerDid: string,
  thid: string,
  requestId?: string,
): void {
  const key = connectionThreadKey(controllerDid, requestId);
  if (activeThreadByConnection.get(key) === thid) {
    activeThreadByConnection.delete(key);
  }
}

export function getActiveConversation(controllerDid: string, requestId?: string): string {
  return (
    activeThreadByConnection.get(connectionThreadKey(controllerDid, requestId)) ?? DEFAULT_THID
  );
}

/** Return shape of `messaging.resolveSessionConversation(...)`. */
export interface Ac2SessionConversation {
  baseConversationId: string;
  threadId?: string;
  /** Parent candidates, ordered narrowest → broadest. */
  parentConversationCandidates: string[];
}

/** Map `ac2:<controllerDid>[:<thid>]` to its base + optional thread. */
export function resolveAc2SessionConversation(rawId: string): Ac2SessionConversation {
  const id = rawId.startsWith(`${CHANNEL_ID}:`) ? rawId.slice(CHANNEL_ID.length + 1) : rawId;
  const parts = id.split(':');
  const isDid = parts[0] === 'did';
  const didSegmentCount = isDid ? 3 : 1;
  if (parts.length <= didSegmentCount) {
    return { baseConversationId: id, parentConversationCandidates: [id] };
  }
  const baseConversationId = parts.slice(0, didSegmentCount).join(':');
  const threadId = parts.slice(didSegmentCount).join(':');
  if (threadId.length === 0 || threadId === DEFAULT_THID) {
    return { baseConversationId, parentConversationCandidates: [baseConversationId] };
  }
  return {
    baseConversationId,
    threadId,
    parentConversationCandidates: [`${baseConversationId}:${threadId}`, baseConversationId],
  };
}

/** Return shape of `messaging.resolveOutboundSessionRoute(...)`. */
export interface Ac2OutboundSessionRoute {
  sessionKey: string;
  baseSessionKey: string;
  peer: { kind: 'direct'; id: string };
  chatType: 'direct';
  from: string;
  to: string;
  threadId?: string;
}

/** Resolve the outbound session key for a target controller DID. */
export function resolveAc2OutboundSessionRoute(params: {
  target: string;
  from: string;
  threadId?: string | number | null;
}): Ac2OutboundSessionRoute {
  const { baseConversationId, threadId: parsedThid } = resolveAc2SessionConversation(params.target);
  const to = baseConversationId;
  const explicit =
    params.threadId !== undefined && params.threadId !== null && String(params.threadId).length > 0
      ? String(params.threadId)
      : undefined;
  const thid = explicit ?? parsedThid ?? DEFAULT_THID;
  const baseSessionKey = buildAc2SessionKey(to);
  const sessionKey = buildAc2SessionKey(to, thid);
  return {
    sessionKey,
    baseSessionKey,
    peer: { kind: 'direct', id: to },
    chatType: 'direct',
    from: params.from,
    to,
    ...(thid !== DEFAULT_THID ? { threadId: thid } : {}),
  };
}

/** Parse an inbound chat frame into `{ thid, text, explicitThid }`. */
export function parseInboundChat(raw: string): {
  thid: string;
  text: string;
  explicitThid: boolean;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { thid: DEFAULT_THID, text: '', explicitThid: false };
  if (trimmed[0] !== '{') return { thid: DEFAULT_THID, text: raw, explicitThid: false };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, any>;
    const hasThid = typeof parsed['thid'] === 'string' && parsed['thid'].length > 0;
    const thid = hasThid ? (parsed['thid'] as string) : DEFAULT_THID;
    const body = (parsed['body'] ?? {}) as Record<string, any>;
    const text =
      typeof body['content'] === 'string'
        ? (body['content'] as string)
        : typeof body['text'] === 'string'
          ? (body['text'] as string)
          : typeof parsed['text'] === 'string'
            ? (parsed['text'] as string)
            : raw;
    return { thid, text, explicitThid: hasThid };
  } catch {
    return { thid: DEFAULT_THID, text: raw, explicitThid: false };
  }
}

/** Replay persisted threads as a `conversations` control frame. */
export function replayConversationList(transport: Sendable, requestId: string | undefined): void {
  if (!requestId) return;
  const conversations = listConversations(requestId);
  if (conversations.length === 0) return;
  sendStreamControl(transport, {
    t: 'conversations',
    threads: conversations.map((c) => ({
      thid: c.thid,
      ...(c.title !== undefined ? { title: c.title } : {}),
      updatedAt: c.updatedAt,
    })),
  });
}

/** Replay one thread's persisted history as a `history` control frame. */
export function replayConversationHistory(
  transport: Sendable,
  requestId: string | undefined,
  thid: string,
): void {
  if (!requestId) return;
  const conversation = listConversations(requestId).find((c) => c.thid === thid);
  if (!conversation || conversation.messages.length === 0) return;
  sendStreamControl(transport, {
    t: 'history',
    thid,
    ...(conversation.title !== undefined ? { title: conversation.title } : {}),
    messages: conversation.messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          text: '',
          at: m.at,
          ...(m.id !== undefined ? { id: m.id } : {}),
          ...(m.tool !== undefined ? { name: m.tool } : {}),
          ...(m.command !== undefined ? { command: m.command } : {}),
          ...(m.output !== undefined ? { output: m.output } : {}),
        };
      }
      if (m.role === 'task') {
        return {
          role: 'task' as const,
          text: '',
          at: m.at,
          ...(m.id !== undefined ? { id: m.id } : {}),
          ...(m.title !== undefined ? { title: m.title } : {}),
          ...(m.prompt !== undefined ? { prompt: m.prompt } : {}),
          ...(m.status !== undefined ? { status: m.status } : {}),
          ...(m.result !== undefined ? { result: m.result } : {}),
        };
      }
      return {
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        text: m.text,
        at: m.at,
      };
    }),
  });
}
