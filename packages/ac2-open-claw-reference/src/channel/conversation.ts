/** Conversation multiplexing: session-key + route resolution for the ac2 channel. */

import { CHANNEL_ID } from '../runtime.js';

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

/**
 * Resolve the "active" conversation thread for a controller connection.
 *
 * The daemon's `openclaw-gateway` adapter now owns the whole run/reply
 * lifecycle (including which thread a turn belongs to) — this plugin never
 * sees `ac2/ConversationOpen`/`Close` frames anymore (the handlers that used
 * to track them lived in `ac2-command.ts` and were removed), so there is no
 * longer anything to set an "active" thread FROM. Both parameters are kept
 * (unused) purely so this stays a drop-in replacement at every call site in
 * `channel-object.ts` — collapsing to the default thread is the correct
 * behavior until/unless a thread is resolved some other way (e.g. from the
 * outbound route).
 */
export function getActiveConversation(_controllerDid: string, _requestId?: string): string {
  return DEFAULT_THID;
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

