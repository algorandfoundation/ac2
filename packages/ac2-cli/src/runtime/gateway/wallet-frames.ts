/**
 * `ac2-stream` control-frame builders and the inbound-chat/session-key
 * helpers used by the `openclaw-gateway` adapter.
 *
 * WHY DUPLICATED, NOT IMPORTED: the canonical implementation lives in
 * `packages/ac2-open-claw-reference/src/channel/stream.ts` and
 * `.../channel/conversation.ts`, but that package is the OpenClaw PLUGIN —
 * an in-process consumer of `@algorandfoundation/ac2-cli`'s control socket,
 * not a dependency of it. Importing it here would invert the dependency
 * direction (the CLI would depend on the plugin) and would also drag in
 * `openclaw/plugin-sdk`. This module is a self-contained copy of exactly
 * the wire format, field-for-field, so the wallet renders identical output
 * regardless of which adapter (control-socket plugin vs. this gateway
 * adapter) produced it. Any change to the wire format on one side must be
 * mirrored here by hand.
 */

/** STX prefix marking an `ac2-stream` control frame (vs. a plain chat frame). */
export const AC2_STREAM_CONTROL_PREFIX = '\u0002';

/** Channel id this adapter's session keys are namespaced under. */
export const CHANNEL_ID = 'ac2';

/** The thread id used when the wallet frame carries no explicit thread. */
export const DEFAULT_THID = 'default';

export type Ac2LivePhase = 'thinking' | 'tool' | 'typing';
export type Ac2NoticeLevel = 'info' | 'warning' | 'error';

/** Lifecycle of a background-task (sub-agent) card on the wire. */
export type Ac2TaskCardStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** Build a `preview` control frame (`text` is cumulative for `typing`). */
export function buildPreviewFrame(
  thid: string,
  phase: Ac2LivePhase,
  opts?: { text?: string; detail?: string },
): string {
  return (
    AC2_STREAM_CONTROL_PREFIX +
    JSON.stringify({
      t: 'preview',
      thid,
      phase,
      ...(opts?.text !== undefined ? { text: opts.text } : {}),
      ...(opts?.detail ? { detail: opts.detail } : {}),
    })
  );
}

/** Build a `finalize` control frame (final reply for the live preview). */
export function buildFinalizeFrame(thid: string, mid: string, text: string): string {
  return AC2_STREAM_CONTROL_PREFIX + JSON.stringify({ t: 'finalize', thid, mid, text });
}

/** Build a `discard` control frame (drop the live preview without a reply). */
export function buildDiscardFrame(thid: string): string {
  return AC2_STREAM_CONTROL_PREFIX + JSON.stringify({ t: 'discard', thid });
}

/** Build a `notice` control frame (out-of-band advisory banner). */
export function buildNoticeFrame(notice: {
  code: string;
  level?: Ac2NoticeLevel;
  title?: string;
  text: string;
}): string {
  return (
    AC2_STREAM_CONTROL_PREFIX +
    JSON.stringify({
      t: 'notice',
      code: notice.code,
      level: notice.level ?? 'warning',
      ...(notice.title ? { title: notice.title } : {}),
      text: notice.text,
    })
  );
}

/**
 * A durable tool-activity card: one record of a tool/exec step the agent ran.
 * The wallet persists it de-duped by `id` and renders it as its own item in
 * the thread timeline (see `addToolActivity`), independent of the ephemeral
 * `preview` phase `'tool'` indicator — so re-emitting the same `id` with more
 * `output` upserts the card in place instead of adding a second one.
 */
export interface Ac2ToolCard {
  id: string;
  name?: string;
  command?: string;
  output?: string;
}

/**
 * Build a `tool` control frame (durable tool card, de-duped by `id`).
 * Thread-scoped: the wallet files the card under `thid`, so a card produced
 * by a run in one conversation never lands in another.
 */
export function buildToolFrame(thid: string, card: Ac2ToolCard): string {
  return (
    AC2_STREAM_CONTROL_PREFIX +
    JSON.stringify({
      t: 'tool',
      thid,
      id: card.id,
      ...(card.name ? { name: card.name } : {}),
      ...(card.command ? { command: card.command } : {}),
      ...(card.output !== undefined ? { output: card.output } : {}),
    })
  );
}

/**
 * A durable background-task card: one sub-agent run delegated by the agent.
 * Unlike a tool card it is self-contained and STATEFUL — it is first emitted
 * `running` and later re-emitted with the SAME `id` carrying a terminal
 * `status` plus the child's `result` text inline, so the wallet renders one
 * card that flips from running to done/failed with the answer inside it
 * (rather than a stale "running…" card plus a disconnected reply bubble).
 */
export interface Ac2TaskCard {
  id: string;
  title: string;
  status: Ac2TaskCardStatus;
  prompt?: string;
  result?: string;
}

/** Build a `task` control frame (durable sub-agent card, upserted by `id`). */
export function buildTaskFrame(thid: string, card: Ac2TaskCard): string {
  return (
    AC2_STREAM_CONTROL_PREFIX +
    JSON.stringify({
      t: 'task',
      thid,
      id: card.id,
      title: card.title,
      status: card.status,
      ...(card.prompt !== undefined ? { prompt: card.prompt } : {}),
      ...(card.result !== undefined ? { result: card.result } : {}),
    })
  );
}

/**
 * One replayed history entry for a `history` control frame. The wallet's
 * control-frame handler (see `ac2-wallet/lib/ac2/streamControlFrame.ts`,
 * case `'history'`) accepts plain `user`/`assistant` turns that carry a
 * `text`, plus `tool` and `task` card entries (which carry no text and are
 * restored as the same cards the live `tool`/`task` frames produce — they
 * coalesce by `id`). All four are replayed so a returning wallet sees the
 * tool/sub-agent cards of past turns, not just the chat bubbles.
 */
export type Ac2HistoryMessage =
  | {
      role: 'user' | 'assistant';
      text: string;
      /** Epoch-ms timestamp, when known (the wallet orders/de-dupes by it). */
      at?: number;
    }
  | ({ role: 'tool'; at?: number } & Ac2ToolCard)
  | ({ role: 'task'; at?: number } & Ac2TaskCard);

/**
 * Build a `history` control frame replaying a thread's past transcript. The
 * wallet restores it **idempotently, replacing** its local copy of `thid`
 * (see the wallet's `setThreadHistory`), so this must carry the FULL known
 * transcript for the thread, not a delta.
 */
export function buildHistoryFrame(thid: string, messages: Ac2HistoryMessage[]): string {
  return (
    AC2_STREAM_CONTROL_PREFIX +
    JSON.stringify({
      t: 'history',
      thid,
      messages: messages.map((m) => {
        const at = typeof m.at === 'number' ? { at: m.at } : {};
        if (m.role === 'tool') {
          return {
            role: 'tool',
            id: m.id,
            ...(m.name ? { name: m.name } : {}),
            ...(m.command ? { command: m.command } : {}),
            ...(m.output !== undefined ? { output: m.output } : {}),
            ...at,
          };
        }
        if (m.role === 'task') {
          return {
            role: 'task',
            id: m.id,
            title: m.title,
            status: m.status,
            ...(m.prompt !== undefined ? { prompt: m.prompt } : {}),
            ...(m.result !== undefined ? { result: m.result } : {}),
            ...at,
          };
        }
        return { role: m.role, text: m.text, ...at };
      }),
    })
  );
}

/** One advertised conversation for a `conversations` control frame. */
export interface Ac2ConversationSummary {
  thid: string;
  title?: string;
  /** Epoch-ms timestamp of the last activity, when known. */
  updatedAt?: number;
}

/**
 * Build a `conversations` control frame advertising the threads the service
 * already holds for this connection, so the wallet can surface (and switch
 * to) conversations it has no local copy of (see the wallet's
 * `setRemoteThreads`).
 */
export function buildConversationsFrame(threads: Ac2ConversationSummary[]): string {
  return (
    AC2_STREAM_CONTROL_PREFIX +
    JSON.stringify({
      t: 'conversations',
      threads: threads.map((t) => ({
        thid: t.thid,
        ...(t.title !== undefined ? { title: t.title } : {}),
        ...(typeof t.updatedAt === 'number' ? { updatedAt: t.updatedAt } : {}),
      })),
    })
  );
}

/**
 * Build the canonical OpenClaw session key for a controller + thread. The
 * default thread collapses to the bare `ac2:<controllerDid>` base key — see
 * the matching JSDoc in the plugin's `conversation.ts` for why that
 * collapse matters (keeps the default-thread key identical across every
 * code path that resolves it).
 */
export function buildAc2SessionKey(controllerDid: string, thid?: string): string {
  const base = `${CHANNEL_ID}:${controllerDid}`;
  return thid !== undefined && thid.length > 0 && thid !== DEFAULT_THID ? `${base}:${thid}` : base;
}

/** Parse an inbound wallet chat frame into `{ thid, text, explicitThid }`. */
export function parseInboundChat(raw: string): {
  thid: string;
  text: string;
  explicitThid: boolean;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { thid: DEFAULT_THID, text: '', explicitThid: false };
  if (trimmed[0] !== '{') return { thid: DEFAULT_THID, text: raw, explicitThid: false };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const hasThid = typeof parsed['thid'] === 'string' && (parsed['thid'] as string).length > 0;
    const thid = hasThid ? (parsed['thid'] as string) : DEFAULT_THID;
    const body = (parsed['body'] ?? {}) as Record<string, unknown>;
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
