/**
 * FIRST-PARTY built-in runtime adapter: drives an OpenClaw agent over the
 * OpenClaw **Gateway** WebSocket/RPC control plane (protocol v4), instead of
 * handing inbound wallet frames to an in-process control-socket agent (the
 * `socket` adapter — see `../socket-adapter.ts`).
 *
 * This makes the Gateway the OWNER of conversation/session state: unlike the
 * `socket` adapter (which hands raw frames to whatever agent process is
 * registered), this adapter never persists a transcript on the AC2 side. It
 * only tracks the bare minimum needed to correlate one in-flight `agent` RPC
 * run with the wallet turn that triggered it.
 *
 * ## Selecting this adapter
 *
 * Opt-in only — the daemon default remains `socket` (see
 * `../loader.ts`). Select this adapter with, in order of precedence: an
 * explicit `DaemonRunOptions.runtime.adapter: 'openclaw-gateway'`, or
 * `AC2_RUNTIME=openclaw-gateway` (see `daemon/run.ts`).
 *
 * ## One wallet message per committed segment
 *
 * A single agent turn can produce several transcript segments — e.g. an intro
 * line, then a tool call (a signing request the wallet renders as its own
 * card), then a closing reply. The Gateway commits each as its own
 * `session.message`, and its live `chat` stream is run-CUMULATIVE (it keeps
 * every earlier segment). So this adapter finalizes ONE wallet message per
 * committed `session.message` (deduped by `messageId`) and drives the live
 * "typing" preview only from the still-uncommitted tail of the `chat`
 * snapshot — instead of collapsing the whole turn into one bubble. That keeps
 * the wallet's timeline ordered as intro → sign card → final reply.
 *
 * ## What is documented vs. best-effort
 *
 * The `connect`/`hello-ok` handshake, `agent`/`agent.wait` shapes,
 * `sessions.messages.subscribe`, and the `chat` / `session.message` streaming
 * events were CONFIRMED against a live Gateway (protocol v4, server 2026.7.x)
 * by probing a real intro→tool→final turn — see
 * `ac2/docs/gateway-live-validation.md` and the JSDoc on
 * {@link interpretGatewayEvent} for the exact fields relied on. `session.tool`
 * is best-effort (delivered to `sessions.subscribe` recipients, so it may be
 * absent — the split does not depend on it).
 */

import { randomUUID } from 'node:crypto';
import type {
  Ac2RuntimeAdapter,
  Ac2RuntimeConversationEvent,
  Ac2RuntimeHost,
  Ac2RuntimeInbound,
} from '@algorandfoundation/ac2-sdk/runtime';
import { createWebSocketConnection, type GatewayConnection } from './connection.js';
import { createGatewayClient, type GatewayClient } from './client.js';
import {
  resolveGatewayConfig,
  type OpenClawConfigFileReader,
  type OpenClawGatewayConfig,
} from './config.js';
import {
  type Ac2ConversationSummary,
  type Ac2HistoryMessage,
  buildAc2SessionKey,
  buildConversationsFrame,
  buildDiscardFrame,
  buildFinalizeFrame,
  buildHistoryFrame,
  buildNoticeFrame,
  buildPreviewFrame,
  buildTaskFrame,
  buildToolFrame,
  DEFAULT_THID,
  parseInboundChat,
} from './wallet-frames.js';

/** Short name this built-in resolves under (see `../loader.ts`). */
export const OPENCLAW_GATEWAY_RUNTIME_ADAPTER_ID = 'openclaw-gateway';

/** Backoff schedule for reconnecting to the Gateway after it drops. */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * Grace window after `agent.wait` resolves OK before the run is detached and
 * reconciled, so a FINAL `session.message` delivered right as the run ends
 * still commits as its own bubble. Small — it only delays the terminal
 * `discard`/leftover-finalize, never the per-segment bubbles.
 */
const RUN_FINALIZE_GRACE_MS = 400;

/**
 * Clock-skew allowance subtracted from a run's start time before it is
 * compared against `chat.history` record timestamps (see `finalizeRun`). The
 * gateway is normally the same host, so this only guards against a message
 * recorded a hair before our `Date.now()`.
 */
const RUN_START_SKEW_MS = 2000;

/**
 * Result shape of the `agent` RPC (accepted response), confirmed against the
 * Gateway source (`agent-run-admission-phase.ts`): `{runId, sessionKey,
 * agentId?, status:'accepted', acceptedAt, runtime?}`. Only `runId` is used
 * here.
 */
interface AgentRpcResult {
  runId: string;
  /**
   * CANONICAL session key the gateway resolved for this run (e.g.
   * `agent:<agentId>:ac2:<did>`). Streamed events carry THIS key, not the raw
   * `ac2:<did>` we sent, so the adapter adopts it for event correlation.
   */
  sessionKey?: string;
  acceptedAt?: unknown;
}

/**
 * Result shape of the `agent.wait` RPC, confirmed against the Gateway source
 * (`agent-wait.ts`). NOTE: it carries `status`/`error` but **no final
 * assistant text or message id** — the final answer must come from the
 * streamed `chat` events, or be read back from `chat.history` (see
 * {@link ChatHistoryResult}). This adapter uses both: it prefers the
 * streamed text and falls back to `chat.history` when the stream produced
 * nothing.
 */
interface AgentWaitResult {
  status: 'ok' | 'error' | 'timeout';
  startedAt?: unknown;
  endedAt?: unknown;
  error?: unknown;
}

/**
 * Result shape of the `chat.history` RPC (scope `operator.read`), confirmed
 * against the Gateway source (`chat-history-handler.ts`): `{sessionKey,
 * sessionId, messages, …}`. Each message carries a `role` and its text as a
 * plain string `content`/`text` or an array of `{type:'text', text}` parts
 * (see {@link extractMessageText}), plus an injected `recordTimestampMs`.
 */
interface ChatHistoryResult {
  messages?: unknown;
}

/** One `chat`/`chat.history` message part (`{type:'text', text}` and friends). */
interface MessageContentPart {
  type?: unknown;
  text?: unknown;
}

/**
 * Result shape of the `sessions.list` RPC (scope `operator.read`), confirmed
 * against the live Gateway: `{sessions:[{key, derivedTitle?, updatedAt?,
 * lastActivityAt?, childSessions?, spawnedBy?, parentSessionKey?, status?,
 * hasActiveRun?}, …]}`. This server REJECTS an unsupported `sortBy` param, so
 * {@link listControllerThreads} sends only `{limit, includeDerivedTitles}`
 * and sorts client-side instead.
 */
interface SessionsListEntry {
  key?: unknown;
  derivedTitle?: unknown;
  updatedAt?: unknown;
  lastActivityAt?: unknown;
  spawnedBy?: unknown;
}
interface SessionsListResult {
  sessions?: unknown;
}

/**
 * A durable tool card already emitted for one `toolCallId` of the active run
 * (see {@link handleToolEvent}). Re-emitting the SAME `cardId` with an
 * updated `output` is what lets the wallet upsert the card in place instead
 * of appending a new one per `session.tool` phase.
 */
interface TrackedToolCard {
  cardId: string;
  name?: string;
  command?: string;
  output?: string;
}

/**
 * A `sessions_spawn` call's start-phase args, captured (keyed by
 * `toolCallId`) so the matching result phase can build the task card's
 * title/prompt — ground truth #2: `args {task, taskName?, label?, agentId?}`.
 */
interface TrackedSpawnArgs {
  task?: string;
  taskName?: string;
  label?: string;
}

/**
 * The accepted-spawn shape parsed out of a `sessions_spawn` tool result (see
 * {@link parseSpawnAccepted}) — ground truth #2: `{status:'accepted',
 * childSessionKey:'agent:main:subagent:<uuid>', runId:'<child run id>',
 * taskName?}`.
 */
interface SpawnAccepted {
  runId: string;
  childSessionKey: string;
  taskName?: string;
}

/** State tracked for exactly one in-flight `agent` run driving one wallet turn. */
interface ActiveRun {
  runId: string;
  thid: string;
  /**
   * CANONICAL session key as returned by the `agent` RPC (`agent:<agentId>:…`),
   * NOT the raw `ac2:<did>` key we sent. Streamed events carry the canonical
   * key, so this is what `session.message` events are correlated against
   * (they carry no `runId`). See {@link interpretGatewayEvent}.
   */
  sessionKey: string;
  /**
   * Last cumulative assistant snapshot seen on a `chat` event. `chat` events
   * are run-cumulative (they concatenate every assistant segment of the run),
   * so this is the whole turn's text so far — used to compute the live
   * "typing" tail (see {@link computeTail}) and, ONLY when the run emitted no
   * `session.message` at all, as the end-of-run fallback text.
   */
  text: string;
  /**
   * Concatenation of the assistant segments already COMMITTED as their own
   * wallet message (one `finalize` per committed `session.message`). It is the
   * prefix of {@link text} that the wallet has already rendered, so the live
   * "typing" preview only ever shows `text` minus this prefix.
   */
  committedText: string;
  /**
   * Epoch-ms the `agent` RPC was issued. Used to reject a STALE
   * `chat.history` message as this run's answer: a turn can legitimately
   * commit no assistant text (it only spawned a sub-agent and yielded), and
   * without this the previous turn's reply was re-posted as a new bubble.
   */
  startedAt: number;
  /** `messageId`s already finalized, so a segment is never committed twice. */
  committedMessageIds: Set<string>;
  /** Durable tool cards already emitted for this run, keyed by `toolCallId`. */
  toolCards: Map<string, TrackedToolCard>;
  /** Captured `sessions_spawn` start-phase args, keyed by `toolCallId`. */
  spawnArgs: Map<string, TrackedSpawnArgs>;
}

/**
 * Compute the still-uncommitted RAW tail of a run-cumulative assistant
 * snapshot for the LIVE typing preview: the text beyond what has already been
 * finalized as its own wallet message. `chat` snapshots concatenate every
 * assistant segment of the run, so once a segment is committed (via its
 * `session.message`) its text is normally a prefix of every later snapshot,
 * and stripping it leaves the segment currently being typed.
 *
 * Returns `null` when the committed text is NOT a byte-exact prefix. This
 * happens because the run-cumulative `chat` snapshot and the concatenated
 * per-segment `session.message` texts normalize whitespace differently (e.g.
 * a segment's trailing newlines) — confirmed live. In that case we cannot
 * isolate the current segment's raw text, so we signal "leave the preview
 * text as-is" rather than risk re-showing already-committed text. Correctness
 * never depends on this: finalization is driven by `session.message` commits,
 * not by this tail.
 */
function computeTail(snapshot: string, committedText: string): string | null {
  if (committedText.length === 0) return snapshot;
  if (snapshot.startsWith(committedText)) return snapshot.slice(committedText.length);
  return null;
}

/**
 * Extract the assistant text from a Gateway message-shaped value. Confirmed
 * shapes (from `session-transcript-readers.ts` / the `chat` event's
 * `message`): a plain string, an array of `{type:'text', text}` parts (text
 * parts joined), or a `{ text }` / `{ content }` object where `content` is
 * itself a string or a parts array. Returns `undefined` when no text is
 * present (e.g. a pure tool-call message).
 */
function extractMessageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const joined = (value as MessageContentPart[])
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
    return joined.length > 0 ? joined : undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if ('content' in obj) {
      const fromContent = extractMessageText(obj['content']);
      if (fromContent !== undefined) return fromContent;
    }
    if (typeof obj['text'] === 'string') return obj['text'];
  }
  return undefined;
}

/**
 * Narrow an {@link Ac2HistoryMessage} to its plain-text `assistant` variant.
 * Needed because `Array.prototype.find`'s predicate narrowing does not flow
 * into its return type for an ARBITRARY boolean expression (only for an
 * explicit type-guard function) — without this, `.find((m) => m.role ===
 * 'assistant')` on the history union still types the result as the whole
 * union, so `.text` (absent from the `tool`/`task` variants) does not
 * type-check even though the runtime value is provably the right shape.
 */
function isAssistantHistoryMessage(
  m: Ac2HistoryMessage,
): m is { role: 'assistant'; text: string; at?: number } {
  return m.role === 'assistant';
}

/**
 * Stable wallet card id for one tool call.
 *
 * Keyed ONLY by the gateway's `toolCallId` — deliberately NOT by `runId` — so
 * the card emitted live during the run and the same call reconstructed from
 * `chat.history` on a later reconnect carry the SAME id. The wallet upserts
 * cards by id, so this makes a replay coalesce with what the user already
 * sees instead of rendering the tool twice.
 */
function toolCardId(toolCallId: string): string {
  return `tool-${toolCallId}`;
}

/**
 * Derive a durable tool card's `command` from its `session.tool` start-phase
 * `args`, ported from the OpenClaw plugin (`openclaw/plugin-sdk`'s AC2
 * channel, since thinned) so tool cards keep showing what they showed
 * before: prefer `args.command` (a string, or a `string[]` joined with a
 * space, e.g. `['ls', '-la']` → `'ls -la'`), then `cmd`, `script`, `path`,
 * `file`, and finally the whole `args` object stringified when it carries
 * anything at all (an empty `{}` yields no command rather than the useless
 * literal `"{}"`).
 */
function formatToolCommand(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const obj = args as Record<string, unknown>;

  const command = obj['command'];
  if (typeof command === 'string' && command.length > 0) return command;
  if (Array.isArray(command) && command.length > 0 && command.every((c) => typeof c === 'string')) {
    return (command as string[]).join(' ');
  }

  for (const key of ['cmd', 'script', 'path', 'file']) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }

  if (Object.keys(obj).length === 0) return undefined;
  try {
    return JSON.stringify(obj);
  } catch {
    return undefined;
  }
}

/** Hard cap on a durable tool card's `output`, past which it is truncated with a `… (N more chars)` marker. */
const MAX_TOOL_OUTPUT_CHARS = 8000;

/**
 * Tolerantly merge a new output chunk (from a `session.tool` `update`/
 * `result` phase) onto the card's output so far, then cap the result. Tool
 * output streams in inconsistent shapes across tools — some deliver
 * successive SNAPSHOTS of the whole output so far (superseding the previous
 * chunk), others deliver true incremental deltas, and a final `result` chunk
 * sometimes duplicates the tail of what `update` already streamed. This
 * picks the least-surprising interpretation without needing to know which
 * tool is talking:
 *
 * - `prev` empty → the chunk IS the output.
 * - `chunk` starts with `prev` → `chunk` is a newer snapshot; it supersedes.
 * - `prev` ends with `chunk` → `chunk` is a redundant repeat of the tail;
 *   keep `prev` unchanged.
 * - otherwise → treat `chunk` as a genuine delta and append it.
 */
function mergeToolOutput(prev: string, chunk: string): string {
  let merged: string;
  if (prev.length === 0) merged = chunk;
  else if (chunk.startsWith(prev)) merged = chunk;
  else if (prev.endsWith(chunk)) merged = prev;
  else merged = prev + chunk;

  if (merged.length > MAX_TOOL_OUTPUT_CHARS) {
    const more = merged.length - MAX_TOOL_OUTPUT_CHARS;
    merged = `${merged.slice(0, MAX_TOOL_OUTPUT_CHARS)}… (${more} more chars)`;
  }
  return merged;
}

/**
 * Extract human-readable text from a `session.tool` `partialResult`/`result`
 * (or a `chat.history` `toolResult`'s `content`) for a durable tool card's
 * `output`. Like {@link extractMessageText} (string, `{content:[{type:'text',
 * text}]}`, `{text}`), but additionally falls back to `JSON.stringify` for a
 * non-empty value with no recognizable text shape — an `isError: true`
 * result, or a structured (non-text) success payload, still needs SOME
 * output on the card rather than none.
 */
function extractToolChunkText(value: unknown): string | undefined {
  const text = extractMessageText(value);
  if (text !== undefined) return text;
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') {
    const isEmpty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
    if (isEmpty) return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Parse an accepted `sessions_spawn` result (ground truth #2) out of either
 * a `session.tool` result phase's `result` or a `chat.history` `toolResult`
 * message (which both carry the acceptance payload, just at different
 * nesting): prefer a `details` object already shaped as the acceptance
 * payload, else JSON.parse the text extracted (via {@link extractMessageText},
 * which already knows how to read a `{content:[{type:'text',text}]}` tool
 * result) from the value itself. Returns `null` for anything that isn't a
 * recognizable `{status:'accepted', runId, childSessionKey}` — e.g. a spawn
 * that was rejected, or a result from some other tool entirely.
 */
function parseSpawnAccepted(value: unknown): SpawnAccepted | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;

  let details: unknown = obj['details'];
  if (typeof details !== 'object' || details === null) {
    const text = extractMessageText(value);
    if (typeof text !== 'string') return null;
    try {
      details = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (typeof details !== 'object' || details === null) return null;

  const d = details as Record<string, unknown>;
  if (d['status'] !== 'accepted') return null;
  if (typeof d['runId'] !== 'string' || typeof d['childSessionKey'] !== 'string') return null;
  return {
    runId: d['runId'],
    childSessionKey: d['childSessionKey'],
    ...(typeof d['taskName'] === 'string' ? { taskName: d['taskName'] } : {}),
  };
}

/**
 * Best-effort epoch-ms timestamp for one raw `chat.history` message. Ground
 * truth #4 nests it under `__openclaw.recordTimestampMs`; a bare top-level
 * `recordTimestampMs` (as an older/mocked history entry — and this adapter's
 * own tests — may carry) and `timestamp` are accepted as fallbacks so neither
 * shape is silently dropped.
 */
function extractHistoryAt(msg: Record<string, unknown>): number | undefined {
  const openclaw = msg['__openclaw'];
  if (typeof openclaw === 'object' && openclaw !== null) {
    const nested = (openclaw as Record<string, unknown>)['recordTimestampMs'];
    if (typeof nested === 'number') return nested;
  }
  if (typeof msg['recordTimestampMs'] === 'number') return msg['recordTimestampMs'] as number;
  if (typeof msg['timestamp'] === 'number') return msg['timestamp'] as number;
  return undefined;
}

/**
 * Map a raw `chat.history` `messages` array into the wallet's
 * `Ac2HistoryMessage[]` (see `wallet-frames.ts`), in transcript order — the
 * REPLACEMENT for the earlier text-only `toHistoryMessage`. WHY THIS MATTERS:
 * the wallet's `history` control frame REPLACES a thread's local copy (see
 * `buildHistoryFrame`'s JSDoc), so a text-only replay used to ERASE the
 * tool/task cards the user had already seen live — this reconstructs them
 * from the same transcript, best-effort, so a returning wallet's timeline
 * matches what it showed before disconnecting:
 *
 * - Plain `user`/`assistant` turns become `{role, text, at}` — an assistant
 *   message whose only content is tool-call parts (empty text) is skipped,
 *   exactly as before.
 * - Each assistant `{type:'toolCall', id, name, arguments}` content part
 *   (ground truth #4) becomes one `{role:'tool', …}` entry, enriched with the
 *   matching `{role:'toolResult', toolCallId}`'s output text when a later
 *   entry supplies one. Its `id` is `tool-<toolCallId>` — the SAME id the
 *   live card uses (see {@link toolCardId}), because the gateway's
 *   `toolCallId` is identical in the live `session.tool` event and in the
 *   persisted transcript. That is deliberate: the wallet upserts cards by id,
 *   so a reconnect-triggered replay coalesces with the card the user can
 *   still see rather than duplicating it. Replaying the cards at all is what
 *   keeps them alive: a `history` frame REPLACES the wallet's copy of the
 *   thread, so a text-only replay would erase every tool/task card the user
 *   had already seen.
 * - Each `sessions_spawn` toolCall whose matching `toolResult` parses as an
 *   accepted spawn (via {@link parseSpawnAccepted}) becomes one
 *   `{role:'task', …, status:'completed'}` entry, using the SAME
 *   `task-<childSessionKey>` id shape the live card uses (see
 *   {@link handleSpawnResult}) so a live card and its later replay coalesce.
 *   `status` is always `'completed'` here — the run is long over by the time
 *   history is replayed, and re-awaiting an old child would be both wrong
 *   (it may have already been garbage-collected) and pointless.
 *
 * Best-effort and defensive throughout: a malformed entry is simply skipped,
 * never thrown.
 */
export function mapHistoryMessages(raw: unknown[]): Ac2HistoryMessage[] {
  const result: Ac2HistoryMessage[] = [];
  /** `toolCallId` → index of its (not-yet-enriched) `tool` entry in `result`. */
  const toolCallIndex = new Map<string, number>();
  /** `toolCallId` → captured `sessions_spawn` call args, awaiting its `toolResult`. */
  const spawnArgsByToolCallId = new Map<string, TrackedSpawnArgs>();

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const msg = entry as Record<string, unknown>;
    const role = msg['role'];
    const at = extractHistoryAt(msg);

    if (role === 'user' || role === 'assistant') {
      const content = msg['content'];
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part !== 'object' || part === null) continue;
          const p = part as Record<string, unknown>;
          if (p['type'] !== 'toolCall' || typeof p['id'] !== 'string') continue;
          const toolCallId = p['id'];
          const name = typeof p['name'] === 'string' ? (p['name'] as string) : undefined;

          if (name === 'sessions_spawn') {
            const args =
              typeof p['arguments'] === 'object' && p['arguments'] !== null
                ? (p['arguments'] as Record<string, unknown>)
                : {};
            spawnArgsByToolCallId.set(toolCallId, {
              ...(typeof args['task'] === 'string' ? { task: args['task'] as string } : {}),
              ...(typeof args['taskName'] === 'string' ? { taskName: args['taskName'] as string } : {}),
              ...(typeof args['label'] === 'string' ? { label: args['label'] as string } : {}),
            });
            // Becomes a task card (from its toolResult below), not a tool card.
            continue;
          }
          // `sessions_yield` leaves nothing durable worth replaying.
          if (name === 'sessions_yield') continue;

          const command = formatToolCommand(p['arguments']);
          toolCallIndex.set(toolCallId, result.length);
          result.push({
            role: 'tool',
            id: toolCardId(toolCallId),
            ...(name ? { name } : {}),
            ...(command ? { command } : {}),
            ...(at !== undefined ? { at } : {}),
          });
        }
      }
      const text = extractMessageText(content) ?? extractMessageText(msg['text']);
      if (text !== undefined && text.trim().length > 0) {
        result.push({ role, text, ...(at !== undefined ? { at } : {}) });
      }
      continue;
    }

    if (role === 'toolResult') {
      const toolCallId = typeof msg['toolCallId'] === 'string' ? (msg['toolCallId'] as string) : undefined;
      if (!toolCallId) continue;

      const spawnArgs = spawnArgsByToolCallId.get(toolCallId);
      if (spawnArgs !== undefined) {
        const accepted = parseSpawnAccepted(msg);
        if (accepted) {
          const title =
            spawnArgs.taskName ??
            spawnArgs.label ??
            (spawnArgs.task !== undefined ? spawnArgs.task.slice(0, 60) : undefined) ??
            'Background task';
          result.push({
            role: 'task',
            id: `task-${accepted.childSessionKey}`,
            title,
            status: 'completed',
            ...(spawnArgs.task !== undefined ? { prompt: spawnArgs.task } : {}),
            ...(at !== undefined ? { at } : {}),
          });
        }
        continue;
      }

      const idx = toolCallIndex.get(toolCallId);
      if (idx === undefined) continue;
      const existing = result[idx];
      if (!existing || existing.role !== 'tool') continue;
      const chunk = extractToolChunkText(msg['content']);
      if (chunk !== undefined) {
        result[idx] = { ...existing, output: mergeToolOutput(existing.output ?? '', chunk) };
      }
      continue;
    }
  }

  return result;
}

/** One interpreted Gateway stream event, mapped onto the active run. */
type InterpretedEvent =
  /** A run-cumulative live snapshot of the assistant's text so far (`chat`). */
  | { kind: 'typing'; snapshot: string }
  /**
   * One COMMITTED assistant transcript segment (`session.message`). This is
   * the split boundary: each becomes its own finalized wallet message so an
   * intro before a tool call and the reply after it land in separate bubbles.
   */
  | { kind: 'commit'; messageId: string; text: string }
  /**
   * One phase of a tool call lifecycle (`session.tool`, ground truth #1):
   * `start` carries `args`, `update` carries a `partialResult`, `result`
   * carries the final `result` (plus `isError`). Driven onto durable tool
   * cards (or a task card, for `sessions_spawn`) by {@link handleToolEvent}.
   */
  | {
      kind: 'tool';
      phase: 'start' | 'update' | 'result';
      toolCallId: string;
      name: string;
      args?: unknown;
      partialResult?: unknown;
      result?: unknown;
      isError?: boolean;
    };

/**
 * Interpret one Gateway `event` frame in the context of the active run.
 * Returns `null` when the event is unrelated or carries nothing actionable.
 *
 * All shapes below were CONFIRMED against a live Gateway (protocol v4, server
 * 2026.7.x) by probing a real intro→tool→final turn — see
 * `ac2/docs/gateway-live-validation.md`:
 *
 * - `chat` — run-cumulative live text. `{runId, sessionKey, state:'delta'|
 *   'final', deltaText?, replace?, message:{role:'assistant',
 *   content:[{type:'text',text}]}}`. `message.content[0].text` is the
 *   CUMULATIVE snapshot of the WHOLE run (it keeps every earlier segment's
 *   text even across a tool call), so it is used only to drive the live
 *   "typing" preview of the current (uncommitted) tail — never to finalize.
 *   Correlated by `runId` (or the canonical `sessionKey`).
 * - `session.message` — one COMMITTED transcript message. `{sessionKey,
 *   message:{role, content}, messageId, messageSeq}`. Fires once per segment
 *   (user turn, each assistant segment) with that segment's text ONLY (not
 *   cumulative) and a stable `messageId`. Carries NO `runId`, so it is
 *   correlated by the canonical `sessionKey`. Only `role:'assistant'`
 *   segments are committed as agent bubbles (the user's own text is skipped).
 * - `session.tool` — CONFIRMED (ground truth #1) as the raw agent event
 *   `{runId, seq, stream:'tool', ts, sessionKey, agentId, spawnedBy?, data}`
 *   where `data` is `{phase:'start', name, toolCallId, args}` /
 *   `{phase:'update', name, toolCallId, partialResult}` /
 *   `{phase:'result', name, toolCallId, meta?, isError, result,
 *   toolErrorSummary?}`. NOT required for the message split above (delivered
 *   only to `sessions.subscribe` recipients, so it may be absent), but IS
 *   the sole source of the durable tool/task cards driven by
 *   {@link handleToolEvent} — see the module JSDoc's "DURABLE TOOL CARDS"
 *   section.
 */
function interpretGatewayEvent(event: string, payload: unknown, active: ActiveRun): InterpretedEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const data = payload as Record<string, unknown>;

  const payloadSessionKey = typeof data['sessionKey'] === 'string' ? data['sessionKey'] : undefined;
  const payloadSession = typeof data['session'] === 'string' ? data['session'] : undefined;
  const payloadRunId = typeof data['runId'] === 'string' ? data['runId'] : undefined;
  const hasCorrelation =
    payloadSessionKey !== undefined || payloadSession !== undefined || payloadRunId !== undefined;
  const matchesActive =
    payloadRunId === active.runId ||
    payloadSessionKey === active.sessionKey ||
    payloadSession === active.sessionKey;
  // When a payload carries any correlation field, it MUST match this run; when
  // it carries none, it is assumed to belong to the only in-flight run.
  if (hasCorrelation && !matchesActive) return null;

  if (event === 'chat') {
    const snapshot = extractMessageText(data['message']);
    if (snapshot !== undefined) return { kind: 'typing', snapshot };
    if (typeof data['deltaText'] === 'string') {
      const delta = data['deltaText'] as string;
      return { kind: 'typing', snapshot: data['replace'] === true ? delta : active.text + delta };
    }
    return null;
  }

  if (event === 'session.message') {
    const message = data['message'];
    const role =
      typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)['role']
        : undefined;
    // Only the agent's own segments become bubbles; the user already sees
    // their own message locally, and other roles (e.g. tool) are not chat.
    if (role !== 'assistant') return null;
    const text = extractMessageText(message);
    if (text === undefined || text.trim().length === 0) return null;
    const messageId =
      typeof data['messageId'] === 'string' && data['messageId'].length > 0
        ? (data['messageId'] as string)
        : typeof data['messageSeq'] === 'number'
          ? `seq-${data['messageSeq'] as number}`
          : `anon-${text.length}`;
    return { kind: 'commit', messageId, text };
  }

  if (event === 'session.tool') {
    const toolFromData =
      typeof data['data'] === 'object' && data['data'] !== null
        ? (data['data'] as Record<string, unknown>)
        : undefined;
    if (!toolFromData) return null;
    const phase = toolFromData['phase'];
    if (phase !== 'start' && phase !== 'update' && phase !== 'result') return null;
    const name = typeof toolFromData['name'] === 'string' ? (toolFromData['name'] as string) : undefined;
    const toolCallId =
      typeof toolFromData['toolCallId'] === 'string' ? (toolFromData['toolCallId'] as string) : undefined;
    if (!name || !toolCallId) return null;
    return {
      kind: 'tool',
      phase,
      toolCallId,
      name,
      ...(toolFromData['args'] !== undefined ? { args: toolFromData['args'] } : {}),
      ...(toolFromData['partialResult'] !== undefined ? { partialResult: toolFromData['partialResult'] } : {}),
      ...(toolFromData['result'] !== undefined ? { result: toolFromData['result'] } : {}),
      ...(typeof toolFromData['isError'] === 'boolean' ? { isError: toolFromData['isError'] as boolean } : {}),
    };
  }

  return null;
}

/**
 * Construct the built-in `openclaw-gateway` adapter. Only ever called by
 * `../loader.ts` for the `openclaw-gateway` built-in name.
 */
export function createOpenClawGatewayAdapter(
  host: Ac2RuntimeHost,
  config: Record<string, unknown>,
): Ac2RuntimeAdapter {
  // Test seam: an injected `openclaw.json` reader, so unit tests can drive
  // (or disable) token/port discovery without touching the host's real
  // `~/.openclaw`. Never a documented part of the public config surface.
  const readOpenClawConfigFile =
    typeof config['__readOpenClawConfigFile'] === 'function'
      ? (config['__readOpenClawConfigFile'] as OpenClawConfigFileReader)
      : undefined;
  const cfg: OpenClawGatewayConfig = resolveGatewayConfig(
    config,
    process.env,
    host.log,
    ...(readOpenClawConfigFile ? [readOpenClawConfigFile] : []),
  );

  // Test seam: a fake `GatewayConnection` factory injected on `config`,
  // never a documented part of the adapter's public config surface.
  const connectionFactory =
    typeof config['__connectionFactory'] === 'function'
      ? (config['__connectionFactory'] as (url: string) => GatewayConnection)
      : createWebSocketConnection;

  let client: GatewayClient | null = null;
  let stopped = false;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;

  /** Session keys already subscribed via `sessions.messages.subscribe` on the current connection. */
  let subscribedSessionKeys = new Set<string>();
  /** Whether `sessions.subscribe` (session-scoped events, incl. `session.tool`) succeeded on the current connection. */
  let sessionEventsSubscribed = false;
  /** The single in-flight run this adapter instance is currently tracking, if any. */
  let activeRun: ActiveRun | null = null;
  /** Snapshot of the wallet connection, as last reported by `onConnected`. */
  let currentConnectionInfo: { controllerDid: string | null; locked: boolean } = {
    controllerDid: null,
    locked: false,
  };
  /**
   * The thread (`thid`) the wallet is CURRENTLY looking at, per
   * {@link Ac2RuntimeAdapter.onConversation}. A bare, non-JSON wallet frame
   * (no explicit `thid` — see `parseInboundChat`) targets THIS thread rather
   * than always collapsing to {@link DEFAULT_THID}, and it is also what
   * scopes durable tool/task cards and the live preview to the thread the
   * user is actually watching. Reset to {@link DEFAULT_THID} on disconnect
   * (a fresh connection starts back on the default thread until the wallet
   * says otherwise).
   */
  let activeThid: string = DEFAULT_THID;
  /**
   * Every in-flight `watchSpawnedTask` promise, so `stop()` at least knows
   * they exist (no RPC to cancel — `agent.wait` has no cancellation — but
   * each watcher checks {@link stopped} before emitting, so a card never
   * lands after the adapter has been told to shut down).
   */
  const inFlightSpawnWatchers = new Set<Promise<void>>();

  /**
   * Finalize one committed assistant segment as its OWN wallet message and
   * record it so (a) the same segment is never committed twice and (b) the
   * live "typing" preview thereafter only shows text BEYOND it. This is the
   * whole fix: a turn is split into a bubble per committed `session.message`
   * (so an intro before a tool call, and the reply after it, are separate
   * items around the durable sign card) instead of one bubble per run. The
   * gateway's stable `messageId` doubles as the wallet `mid`.
   */
  function commitSegment(run: ActiveRun, messageId: string, text: string): void {
    if (run.committedMessageIds.has(messageId)) return;
    run.committedMessageIds.add(messageId);
    run.committedText += text;
    void host.send(buildFinalizeFrame(run.thid, messageId, text), 'stream');
  }

  /**
   * Reconcile a run that ended OK.
   *
   * Finalization authority is the per-segment `session.message` stream (each
   * committed as its own bubble in {@link commitSegment}). This handles only
   * the leftovers, WITHOUT subtracting the run-cumulative `chat` snapshot from
   * the committed text (those two normalize whitespace differently, so string
   * subtraction produced a spurious duplicate "merged" bubble — caught live):
   *
   * - If ANY segment was committed via `session.message`, trust that stream in
   *   full and just clear the live preview (`discard`). A brief grace before
   *   this runs (see the caller) lets a just-in-time FINAL `session.message`
   *   land, so nothing is dropped.
   * - Else if the run streamed text but emitted no `session.message` at all
   *   (older/edge gateways), finalize that whole streamed text as one bubble.
   * - Else (nothing streamed and nothing committed) read the final assistant
   *   message back from `chat.history` — `agent.wait` carries no text.
   *
   * Must run AFTER `activeRun` is detached so no late event double-commits.
   */
  async function finalizeRun(run: ActiveRun, requestedSessionKey: string): Promise<void> {
    if (run.committedMessageIds.size > 0) {
      void host.send(buildDiscardFrame(run.thid), 'stream');
      return;
    }
    const streamed = run.text.trim();
    if (streamed.length > 0) {
      void host.send(buildFinalizeFrame(run.thid, randomUUID(), streamed), 'stream');
      run.committedText += streamed;
      return;
    }
    const history = await fetchHistory(requestedSessionKey);
    const lastAssistant = [...history].reverse().find(isAssistantHistoryMessage);
    // Only accept a history message that belongs to THIS run. Without the
    // timestamp check, a turn that legitimately produced no assistant text
    // (e.g. the agent only spawned a sub-agent and yielded) re-finalized the
    // PREVIOUS answer as a brand-new bubble — observed live as a duplicated
    // reply. When there is nothing new, clear the preview instead of inventing
    // a message; a sub-agent's answer arrives later on its own task card.
    const fresh =
      lastAssistant !== undefined &&
      lastAssistant.text.trim().length > 0 &&
      (lastAssistant.at === undefined || lastAssistant.at >= run.startedAt);
    if (!fresh) {
      void host.send(buildDiscardFrame(run.thid), 'stream');
      return;
    }
    void host.send(buildFinalizeFrame(run.thid, randomUUID(), lastAssistant.text), 'stream');
  }

  /**
   * Await a `sessions_spawn` child run in the background, DETACHED from the
   * parent turn that spawned it (ground truth #2: `sessions_yield` ends the
   * parent turn while children run, so the wallet must not be kept waiting
   * on this). Fire-and-forget from the caller's perspective — every failure
   * mode (RPC error, `agent.wait` timeout/error, an exception reading back
   * `chat.history`) is caught here and turned into a `failed` task card
   * rather than ever propagating into `handleInbound`. The card's `id` is
   * fixed at spawn time (`task-<childSessionKey>`) so this re-emission
   * upserts the SAME card the `running` one already put on the wallet's
   * timeline, and `thid` is the thread the wallet was looking at WHEN the
   * spawn happened — not whatever is active by the time the child finishes.
   */
  function watchSpawnedTask(watch: {
    cardId: string;
    title: string;
    prompt?: string;
    thid: string;
    childRunId: string;
    childSessionKey: string;
  }): void {
    const promise = (async () => {
      host.log(
        `[ac2][openclaw-gateway] awaiting background task ${watch.childSessionKey} (run ${watch.childRunId})`,
      );
      try {
        if (!client) throw new Error('gateway not connected');
        // The RPC's own client-side timeout is kept slightly ABOVE the
        // server-side `agent.wait` timeout it carries as a param, so a
        // server-side timeout response always wins the race and yields the
        // honest `failed` reason below instead of a generic client timeout.
        const waitResult = await client.request<AgentWaitResult>(
          'agent.wait',
          { runId: watch.childRunId, timeoutMs: cfg.taskTimeoutMs },
          cfg.taskTimeoutMs + 5000,
        );
        if (stopped) return;

        if (waitResult.status !== 'ok') {
          const result =
            waitResult.status === 'timeout'
              ? 'Background task timed out.'
              : 'Background task ran into an error.';
          host.log(
            `[ac2][openclaw-gateway] background task ${watch.childSessionKey} ${waitResult.status}`,
          );
          await host.send(
            buildTaskFrame(watch.thid, {
              id: watch.cardId,
              title: watch.title,
              status: 'failed',
              ...(watch.prompt !== undefined ? { prompt: watch.prompt } : {}),
              result,
            }),
            'stream',
          );
          return;
        }

        const history = await fetchHistory(watch.childSessionKey);
        const lastAssistant = [...history].reverse().find(isAssistantHistoryMessage);
        const result =
          lastAssistant && lastAssistant.text.trim().length > 0 ? lastAssistant.text : '(no reply)';
        if (stopped) return;
        host.log(`[ac2][openclaw-gateway] background task ${watch.childSessionKey} completed`);
        await host.send(
          buildTaskFrame(watch.thid, {
            id: watch.cardId,
            title: watch.title,
            status: 'completed',
            ...(watch.prompt !== undefined ? { prompt: watch.prompt } : {}),
            result,
          }),
          'stream',
        );
      } catch (err) {
        if (stopped) return;
        host.log(
          `[ac2][openclaw-gateway] background task ${watch.childSessionKey} errored: ${(err as Error).message}`,
        );
        await host.send(
          buildTaskFrame(watch.thid, {
            id: watch.cardId,
            title: watch.title,
            status: 'failed',
            ...(watch.prompt !== undefined ? { prompt: watch.prompt } : {}),
            result: 'Background task ran into an error.',
          }),
          'stream',
        );
      }
    })();
    inFlightSpawnWatchers.add(promise);
    void promise.finally(() => inFlightSpawnWatchers.delete(promise));
  }

  /**
   * Handle one `sessions_spawn` phase (see {@link handleToolEvent}, which
   * routes this tool's events here instead of the generic tool-card path).
   * `start` only CAPTURES the call's args (keyed by `toolCallId`) for the
   * matching `result` to use — nothing is emitted yet, since the wallet has
   * nothing to show until the gateway actually accepts the delegation.
   * `result` parses the acceptance (see {@link parseSpawnAccepted}), emits
   * the `running` task card immediately, and kicks off the detached
   * {@link watchSpawnedTask} that will flip it to `completed`/`failed`.
   * `update` never fires for this tool (a spawn either is accepted or
   * isn't) and is ignored.
   */
  function handleSpawnResult(run: ActiveRun, ev: Extract<InterpretedEvent, { kind: 'tool' }>): void {
    if (ev.phase === 'start') {
      const args =
        typeof ev.args === 'object' && ev.args !== null ? (ev.args as Record<string, unknown>) : {};
      run.spawnArgs.set(ev.toolCallId, {
        ...(typeof args['task'] === 'string' ? { task: args['task'] as string } : {}),
        ...(typeof args['taskName'] === 'string' ? { taskName: args['taskName'] as string } : {}),
        ...(typeof args['label'] === 'string' ? { label: args['label'] as string } : {}),
      });
      return;
    }
    if (ev.phase !== 'result') return;

    const spawnArgs = run.spawnArgs.get(ev.toolCallId) ?? {};
    const accepted = parseSpawnAccepted(ev.result);
    if (!accepted) return; // rejected/unrecognized spawn: nothing durable to show

    const title =
      spawnArgs.taskName ??
      spawnArgs.label ??
      (spawnArgs.task !== undefined ? spawnArgs.task.slice(0, 60) : undefined) ??
      'Background task';
    const cardId = `task-${accepted.childSessionKey}`;
    // Capture the thread NOW: the child may take a while, and the wallet may
    // have switched threads by the time it answers (see `watchSpawnedTask`).
    const thidAtSpawn = run.thid;

    void host.send(
      buildTaskFrame(thidAtSpawn, {
        id: cardId,
        title,
        status: 'running',
        ...(spawnArgs.task !== undefined ? { prompt: spawnArgs.task } : {}),
      }),
      'stream',
    );

    watchSpawnedTask({
      cardId,
      title,
      ...(spawnArgs.task !== undefined ? { prompt: spawnArgs.task } : {}),
      thid: thidAtSpawn,
      childRunId: accepted.runId,
      childSessionKey: accepted.childSessionKey,
    });
  }

  /**
   * Drive one `session.tool` phase onto the active run's durable cards (see
   * the module JSDoc's "DURABLE TOOL CARDS" / "SUB-AGENT TASK CARDS"
   * sections). `sessions_spawn` is entirely delegated to
   * {@link handleSpawnResult} (it becomes a task card, never a tool card).
   * `sessions_yield` — the marker a spawning turn uses to end itself while
   * its children run (ground truth #2) — gets a fixed informational tool
   * card instead of a generic one (there is no real "tool" here to name),
   * plus a `thinking` preview so the thread does not look stalled while the
   * background task runs.
   */
  function handleToolEvent(run: ActiveRun, ev: Extract<InterpretedEvent, { kind: 'tool' }>): void {
    if (ev.name === 'sessions_spawn') {
      handleSpawnResult(run, ev);
      return;
    }

    if (ev.name === 'sessions_yield') {
      if (ev.phase !== 'start') return; // a yield has nothing to update/result
      void host.send(buildPreviewFrame(run.thid, 'thinking'), 'stream');
      void host.send(
        buildToolFrame(run.thid, {
          id: toolCardId(ev.toolCallId),
          name: '⏳ awaiting background task',
          output: 'Delegated work is running; results will post here when ready.',
        }),
        'stream',
      );
      return;
    }

    const cardId = toolCardId(ev.toolCallId);

    if (ev.phase === 'start') {
      // Ephemeral indicator (existing behaviour) PLUS the durable card.
      void host.send(buildPreviewFrame(run.thid, 'tool', { detail: ev.name }), 'stream');
      const command = formatToolCommand(ev.args);
      run.toolCards.set(ev.toolCallId, { cardId, name: ev.name, ...(command ? { command } : {}) });
      void host.send(
        buildToolFrame(run.thid, { id: cardId, name: ev.name, ...(command ? { command } : {}) }),
        'stream',
      );
      return;
    }

    // update/result: merge onto whatever card exists (re-created from
    // scratch if `start` was somehow missed — e.g. `sessions.subscribe`
    // dropped it, ground truth #1 notes it may be absent) and re-emit the
    // SAME card id so the wallet upserts it in place. `isError: true` still
    // reaches here — the output simply carries the error text, per the
    // module JSDoc: a failed tool call must never be silently dropped.
    const existing = run.toolCards.get(ev.toolCallId) ?? { cardId, name: ev.name };
    const chunk = extractToolChunkText(ev.phase === 'update' ? ev.partialResult : ev.result);
    if (chunk !== undefined) {
      existing.output = mergeToolOutput(existing.output ?? '', chunk);
    }
    run.toolCards.set(ev.toolCallId, existing);
    void host.send(
      buildToolFrame(run.thid, {
        id: existing.cardId,
        ...(existing.name ? { name: existing.name } : {}),
        ...(existing.command ? { command: existing.command } : {}),
        ...(existing.output !== undefined ? { output: existing.output } : {}),
      }),
      'stream',
    );
  }

  /**
   * Enumerate this controller's threads for the `conversations` frame (see
   * the module JSDoc's "CONVERSATIONS ADVERTISEMENT" section):
   * `sessions.list` (scope `operator.read`) — ground truth #3 — with ONLY
   * `{limit, includeDerivedTitles}` (this server REJECTS `sortBy`, so
   * newest-first ordering is done client-side below). Keeps entries whose
   * `key` contains `:ac2:<controllerDid>` — CASE-INSENSITIVELY, since the
   * wallet's `did:key:` is mixed-case but the gateway lower-cases session
   * keys — and skips sub-agent rows (`:subagent:` in the key, or a
   * `spawnedBy` entry) since those are never conversations a wallet should
   * be able to switch to. Best-effort: returns `[]` (never throws) on any
   * RPC failure, logging the reason, so a `sessions.list` outage never
   * blocks the (separate) default-thread history replay in `onConnected`.
   */
  async function listControllerThreads(controllerDid: string): Promise<Ac2ConversationSummary[]> {
    if (!client) return [];
    try {
      const result = await client.request<SessionsListResult>('sessions.list', {
        limit: cfg.conversationsLimit,
        includeDerivedTitles: true,
      });
      const sessions = Array.isArray(result?.sessions) ? (result.sessions as SessionsListEntry[]) : [];
      const marker = `:ac2:${controllerDid.toLowerCase()}`;
      const threads: Ac2ConversationSummary[] = [];
      for (const entry of sessions) {
        if (typeof entry?.key !== 'string') continue;
        const key = entry.key;
        const keyLower = key.toLowerCase();
        if (keyLower.includes(':subagent:') || entry.spawnedBy) continue;
        const markerIdx = keyLower.indexOf(marker);
        if (markerIdx === -1) continue;
        const rest = key.slice(markerIdx + marker.length);
        const thid = rest.startsWith(':') && rest.length > 1 ? rest.slice(1) : DEFAULT_THID;
        const updatedAt =
          typeof entry.updatedAt === 'number'
            ? entry.updatedAt
            : typeof entry.lastActivityAt === 'number'
              ? entry.lastActivityAt
              : undefined;
        threads.push({
          thid,
          ...(typeof entry.derivedTitle === 'string' ? { title: entry.derivedTitle } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
        });
      }
      threads.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      return threads;
    } catch (err) {
      host.log(`[ac2][openclaw-gateway] sessions.list failed: ${(err as Error).message}`);
      return [];
    }
  }

  function connect(): void {
    if (stopped) return;
    const connection = connectionFactory(cfg.url);
    const gatewayClient = createGatewayClient({
      connection,
      log: host.log,
      ...(cfg.token !== undefined ? { token: cfg.token } : {}),
    });
    client = gatewayClient;

    gatewayClient.onEvent((event, payload) => {
      const run = activeRun;
      if (!run) return;
      const interpreted = interpretGatewayEvent(event, payload, run);
      if (!interpreted) return;
      if (interpreted.kind === 'commit') {
        // A committed assistant segment → its own finalized wallet bubble.
        commitSegment(run, interpreted.messageId, interpreted.text);
      } else if (interpreted.kind === 'typing') {
        // Live, run-cumulative snapshot → show ONLY the still-uncommitted tail,
        // so segments already finalized above are not re-typed underneath.
        run.text = interpreted.snapshot;
        const tail = computeTail(run.text, run.committedText);
        if (tail === null) {
          // Whitespace drift means we can't isolate the current segment's raw
          // text — keep the "typing" presence but don't risk re-showing the
          // already-committed text as a draft.
          void host.send(buildPreviewFrame(run.thid, 'typing'), 'stream');
        } else if (tail.trim().length > 0) {
          void host.send(buildPreviewFrame(run.thid, 'typing', { text: tail }), 'stream');
        }
      } else {
        // One `session.tool` phase → durable tool/task cards (see
        // `handleToolEvent`'s JSDoc for how `sessions_spawn`/`sessions_yield`
        // are special-cased).
        handleToolEvent(run, interpreted);
      }
    });

    gatewayClient.ready
      .then(() => {
        reconnectAttempt = 0;
        host.log('[ac2][openclaw-gateway] gateway connected');
        // The agent runtime this adapter fronts is now ALIVE. Tell the
        // daemon so it can start awaiting a wallet (it deliberately does not
        // until at least one runtime is up — see `Ac2RuntimeHost.reportRuntimeReady`
        // and `managesOwnReadiness` below). Idempotent daemon-side, so it is
        // safe to fire again on every reconnect.
        host.reportRuntimeReady?.();
        void ensureSessionEventsSubscribed();
      })
      .catch((err: unknown) => {
        host.log(`[ac2][openclaw-gateway] gateway connect failed: ${(err as Error).message}`);
      });

    connection.onClose((reason) => {
      if (client === gatewayClient) client = null;
      subscribedSessionKeys = new Set();
      sessionEventsSubscribed = false;
      activeRun = null;
      if (stopped) return;
      host.log(`[ac2][openclaw-gateway] gateway connection closed (${reason}); reconnecting…`);
      scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  /**
   * Register this connection for SESSION-SCOPED events (`sessions.subscribe`,
   * scope `operator.read`, no params).
   *
   * WHY THIS IS SEPARATE FROM {@link ensureSubscribed}: the Gateway keeps two
   * distinct registries. `sessions.messages.subscribe` registers a session
   * *message* subscriber (committed transcript segments — what drives the
   * per-segment split), while `session.tool` — the tool-activity stream this
   * adapter turns into durable tool/task cards — is broadcast ONLY to session
   * *event* subscribers (`server-chat.ts` fans it out to
   * `sessionEventSubscribers`). Confirmed live: with only the message
   * subscription, a turn that genuinely ran a shell tool produced NO tool
   * event at all, so no card could ever appear. Re-issued after every
   * reconnect because the registry is keyed by connection id.
   */
  async function ensureSessionEventsSubscribed(): Promise<void> {
    if (sessionEventsSubscribed || !client) return;
    try {
      await client.request('sessions.subscribe', {});
      sessionEventsSubscribed = true;
      host.log('[ac2][openclaw-gateway] subscribed to session events (tool activity)');
    } catch (err) {
      host.log(
        `[ac2][openclaw-gateway] sessions.subscribe failed (tool cards will be missing): ${(err as Error).message}`,
      );
    }
  }

  async function ensureSubscribed(sessionKey: string): Promise<void> {
    if (subscribedSessionKeys.has(sessionKey) || !client) return;
    try {
      await client.request('sessions.messages.subscribe', { key: sessionKey });
      subscribedSessionKeys.add(sessionKey);
    } catch (err) {
      host.log(
        `[ac2][openclaw-gateway] sessions.messages.subscribe failed for "${sessionKey}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Read a session's past transcript from the gateway (`chat.history`) and
   * map it into the wallet's `Ac2HistoryMessage` shape — see
   * {@link mapHistoryMessages} for how tool/task cards are reconstructed
   * alongside the plain text turns. Returns `[]` on any failure — history
   * replay is best-effort and must never throw.
   */
  async function fetchHistory(sessionKey: string): Promise<Ac2HistoryMessage[]> {
    if (!client) return [];
    try {
      const result = await client.request<ChatHistoryResult>('chat.history', {
        sessionKey,
        limit: cfg.historyLimit,
        ...(cfg.agentId !== undefined ? { agentId: cfg.agentId } : {}),
      });
      const raw = Array.isArray(result?.messages) ? result.messages : [];
      return mapHistoryMessages(raw);
    } catch (err) {
      host.log(
        `[ac2][openclaw-gateway] chat.history failed for "${sessionKey}": ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Restore a thread's history to the wallet on (re)connect: fetch it from
   * the gateway (the source of truth for conversation state under this
   * adapter) and push a single `history` control frame so the wallet
   * idempotently replaces its local copy of that thread. Best-effort and
   * never throws; emits nothing when there is no history.
   */
  async function replayHistory(controllerDid: string, thid: string): Promise<void> {
    const sessionKey = buildAc2SessionKey(controllerDid, thid);
    if (client) {
      try {
        await client.ready;
      } catch {
        return; // gateway not up yet; a later reconnect + onConnected will retry
      }
    } else {
      return;
    }
    const messages = await fetchHistory(sessionKey);
    if (messages.length === 0) return;
    host.log(
      `[ac2][openclaw-gateway] replaying ${messages.length} message(s) of history for thread "${thid}"`,
    );
    await host.send(buildHistoryFrame(thid, messages), 'stream');
  }

  return {
    id: OPENCLAW_GATEWAY_RUNTIME_ADAPTER_ID,

    // This adapter owns its own runtime (the gateway WS link); the daemon
    // must NOT infer liveness from control-socket `agent.hello`. We signal
    // readiness explicitly via `host.reportRuntimeReady()` once the gateway
    // handshake completes (see `connect()` above).
    managesOwnReadiness: true,

    start(): void {
      connect();
    },

    onConnected(info): void {
      currentConnectionInfo = { controllerDid: info.controllerDid, locked: info.locked };
      // ADVERTISE this controller's threads (`conversations` frame) and
      // restore the ACTIVE thread's past conversation FROM the gateway (the
      // owner of conversation state under this adapter) — the default thread
      // on a fresh connect, since `activeThid` only ever changes via
      // `onConversation` and is reset on disconnect below. Both are
      // best-effort/fire-and-forget; a locked connection gets neither (its
      // inbound traffic is dropped anyway), and a `sessions.list` failure
      // (logged inside `listControllerThreads`) never blocks the separate
      // history replay.
      if (!info.locked && info.controllerDid) {
        const controllerDid = info.controllerDid;
        void listControllerThreads(controllerDid).then((threads) =>
          host.send(buildConversationsFrame(threads), 'stream'),
        );
        void replayHistory(controllerDid, activeThid);
      }
      if (!info.locked && !info.identityGranted) {
        void host.send(
          buildNoticeFrame({
            code: 'identity_missing',
            level: 'warning',
            text: 'No agent identity has been granted for this connection yet.',
          }),
          'stream',
        );
      }
    },

    /**
     * Keep the notion of the ACTIVE thread in step with the wallet's UI (see
     * `activeThid`'s JSDoc). On `open`, also HYDRATE that thread the same way
     * a fresh connect does: `ensureSubscribed` its session key and replay its
     * history — this is what makes switching threads in the wallet actually
     * restore that thread's past conversation instead of showing whatever the
     * previous thread happened to leave client-side. Best-effort throughout;
     * never throws into the daemon's `runAdapterHook` wrapper.
     */
    async onConversation(event: Ac2RuntimeConversationEvent): Promise<void> {
      if (event.kind === 'close') {
        if (activeThid === event.thid) activeThid = DEFAULT_THID;
        return;
      }
      activeThid = event.thid;
      // Prefer the DID the event itself carries — it is authoritative for
      // THIS announcement and, unlike `currentConnectionInfo`, does not
      // depend on `onConnected` having already run in this exact call chain
      // (always true in production, where a connection precedes any
      // conversation event, but not guaranteed for a caller driving this
      // hook in isolation).
      const controllerDid = event.controllerDid ?? currentConnectionInfo.controllerDid;
      if (!controllerDid || currentConnectionInfo.locked || !client) return;
      try {
        await client.ready;
      } catch {
        return; // gateway not up yet; nothing to hydrate from
      }
      await ensureSubscribed(buildAc2SessionKey(controllerDid, event.thid));
      await replayHistory(controllerDid, event.thid);
    },

    onDisconnected(): void {
      activeRun = null;
      subscribedSessionKeys = new Set();
      // A fresh connection starts back on the default thread; the wallet
      // will re-announce its active thread (if not the default) once
      // reconnected.
      activeThid = DEFAULT_THID;
    },

    async handleInbound(message: Ac2RuntimeInbound): Promise<void> {
      try {
        const controllerDid = message.controllerDid;
        if (!controllerDid) return;

        const { thid, text, explicitThid } = parseInboundChat(message.payload);
        const trimmed = text.trim();
        if (trimmed.length === 0) return;

        // A bare, non-JSON wallet frame (no explicit `thid`) continues the
        // ACTIVE thread — the one `onConversation` last reported the wallet
        // switched to (default until it says otherwise) — rather than always
        // collapsing to `DEFAULT_THID`. An explicit `thid` in the frame
        // itself still wins outright, exactly as before.
        const effectiveThid = explicitThid ? thid : activeThid;
        const sessionKey = buildAc2SessionKey(controllerDid, effectiveThid);

        await host.send(buildPreviewFrame(effectiveThid, 'thinking'), 'stream');

        if (!client) {
          await host.send(
            buildNoticeFrame({
              code: 'gateway_unavailable',
              level: 'error',
              text: 'The OpenClaw gateway is not reachable right now.',
            }),
            'stream',
          );
          await host.send(buildDiscardFrame(effectiveThid), 'stream');
          return;
        }

        try {
          await client.ready;
        } catch (err) {
          host.log(`[ac2][openclaw-gateway] gateway not ready: ${(err as Error).message}`);
          await host.send(
            buildNoticeFrame({
              code: 'gateway_unavailable',
              level: 'error',
              text: 'The OpenClaw gateway is not reachable right now.',
            }),
            'stream',
          );
          await host.send(buildDiscardFrame(effectiveThid), 'stream');
          return;
        }

        await ensureSubscribed(sessionKey);

        // Marks where THIS turn begins in the transcript, with a small
        // allowance for clock skew between us and the gateway's recorded
        // timestamps, so the `chat.history` fallback can tell this run's
        // answer apart from the previous turn's (see `finalizeRun`).
        const runStartedAt = Date.now() - RUN_START_SKEW_MS;

        const run: ActiveRun = {
          runId: '',
          thid: effectiveThid,
          sessionKey,
          text: '',
          committedText: '',
          startedAt: runStartedAt,
          committedMessageIds: new Set<string>(),
          toolCards: new Map(),
          spawnArgs: new Map(),
        };

        try {
          const agentResult = await client.request<AgentRpcResult>('agent', {
            message: trimmed,
            sessionKey,
            ...(cfg.agentId !== undefined ? { agentId: cfg.agentId } : {}),
            deliver: false,
            idempotencyKey: randomUUID(),
          });
          run.runId = agentResult.runId;
          // Adopt the CANONICAL session key so `session.message` events (which
          // carry no `runId`) correlate to this run — confirmed live.
          if (typeof agentResult.sessionKey === 'string' && agentResult.sessionKey.length > 0) {
            run.sessionKey = agentResult.sessionKey;
          }
          activeRun = run;

          const waitResult = await client.request<AgentWaitResult>('agent.wait', {
            runId: run.runId,
            timeoutMs: cfg.runTimeoutMs,
          });

          if (waitResult.status === 'ok') {
            // `agent.wait` can resolve microseconds before the FINAL segment's
            // `session.message` is delivered. Keep the run live for a brief
            // grace so that trailing commit still lands as its own bubble,
            // THEN detach (so no even-later event double-commits) and
            // reconcile any leftovers.
            await new Promise((resolve) => setTimeout(resolve, RUN_FINALIZE_GRACE_MS));
            activeRun = null;
            await finalizeRun(run, sessionKey);
            return;
          }

          // Detach the run before emitting the failure bubble so no late event
          // double-commits.
          activeRun = null;

          // Timeout / error: segments already committed stay as their bubbles;
          // add one more bubble carrying the failure so the wallet is not left
          // spinning.
          const finalText =
            waitResult.status === 'timeout'
              ? 'The agent did not respond in time.'
              : 'The agent ran into an error and could not complete your request.';
          if (waitResult.status !== 'timeout') {
            host.log(
              `[ac2][openclaw-gateway] run ${run.runId} errored: ${JSON.stringify(waitResult.error)}`,
            );
            await host.send(
              buildNoticeFrame({ code: 'agent_error', level: 'error', text: finalText }),
              'stream',
            );
          }
          await host.send(buildFinalizeFrame(effectiveThid, randomUUID(), finalText), 'stream');
        } catch (err) {
          activeRun = null;
          host.log(`[ac2][openclaw-gateway] agent run failed: ${(err as Error).message}`);
          await host.send(
            buildNoticeFrame({
              code: 'agent_error',
              level: 'error',
              text: 'The agent ran into an error and could not complete your request.',
            }),
            'stream',
          );
          await host.send(
            buildFinalizeFrame(
              effectiveThid,
              randomUUID(),
              'The agent ran into an error and could not complete your request.',
            ),
            'stream',
          );
        }
      } catch (err) {
        host.log(`[ac2][openclaw-gateway] handleInbound failed: ${(err as Error).message}`);
      } finally {
        activeRun = null;
      }
    },

    stop(): void {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      client?.close();
      client = null;
    },
  };
}
