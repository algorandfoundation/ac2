/** Inbound chat routing: wallet → OpenClaw agent → wallet. */

import { CHANNEL_ID, getActiveRuntime, safeLog, type OpenClawApi } from '../runtime.js';
import {
  recordConversationMessage,
  recordTaskActivity,
  recordToolActivity,
} from '../identity/state.js';
import { sessionManager } from '../session/manager.js';
import {
  sendDiscard,
  sendFinalize,
  sendNotice,
  sendPreview,
  sendTaskCard,
  sendToolActivity,
  type Ac2LivePhase,
  type Sendable,
} from './stream.js';
import { buildAc2SessionKey, getActiveConversation, parseInboundChat } from './conversation.js';
import {
  attachSpawnResult,
  findPendingTaskForParent,
  registerTask,
  taskCardId,
  taskDisplayTitle,
  type Ac2Task,
} from './tasks.js';
import { watchTaskCompletion } from './subagent-hooks.js';

/** Built-in host tool that starts an isolated background sub-agent run. */
const TOOL_SESSIONS_SPAWN = 'sessions_spawn';
/** Built-in host tool that ends the turn to await sub-agent completions. */
const TOOL_SESSIONS_YIELD = 'sessions_yield';

/** A parsed accepted-spawn envelope; both fields best-effort. */
interface AcceptedSpawn {
  runId?: string;
  childSessionKey?: string;
}

/** A client-facing classification of a failed agent turn. */
export interface Ac2AgentError {
  /** Machine-readable code for the wallet's `notice` banner. */
  code: string;
  /** Human-facing message delivered to the client as the turn's reply. */
  text: string;
}

/**
 * Substrings (case-insensitive) that mark a provider quota / rate-limit /
 * billing failure. These are the common, transient "the agent can't answer
 * right now" errors that a user can recover from by waiting or topping up,
 * so we surface a tailored, reassuring message rather than a generic failure.
 */
const QUOTA_ERROR_MARKERS = [
  'quota',
  'rate limit',
  'rate_limit',
  'ratelimit',
  'too many requests',
  'insufficient_quota',
  'insufficient funds',
  'insufficient credit',
  'out of credit',
  'billing',
  'payment required',
] as const;

/**
 * Turn a raw agent/provider error into a client-facing message + code.
 *
 * A failed turn (most commonly a provider quota / rate-limit error) previously
 * ended in a silent `discard`, so the wallet was left spinning with no idea the
 * turn had failed. We now classify the error and deliver a real message back to
 * the client: quota/rate-limit/billing failures get a tailored, recoverable
 * message (and a `quota_exceeded` notice code), everything else a generic
 * "couldn't complete your request" message. The raw error text stays in the
 * logs only — it is not leaked to the client.
 */
export function classifyAgentError(raw: unknown): Ac2AgentError {
  const message = raw instanceof Error ? raw.message : String(raw ?? '');
  const lower = message.toLowerCase();
  const isQuota =
    QUOTA_ERROR_MARKERS.some((marker) => lower.includes(marker)) || /\b429\b/.test(message);
  if (isQuota) {
    return {
      code: 'quota_exceeded',
      text: "The agent couldn't respond because it has reached its usage quota. Please try again later.",
    };
  }
  return {
    code: 'agent_error',
    text: "The agent ran into an error and couldn't complete your request. Please try again.",
  };
}

/** A host sub-agent child session key: `agent:<agentId>:subagent:<uuid>`. */
const CHILD_SESSION_KEY_RE = /agent:[^:\s"']+:subagent:[0-9a-fA-F-]{8,}/;

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract `{ runId, childSessionKey }` from an accepted `sessions_spawn` tool
 * result. Capturing `childSessionKey` is what lets the background-task
 * completion poller find the child session and deliver its result, so we are
 * deliberately tolerant about where it lives: the dispatcher may surface the
 * accepted envelope as a JSON string in `.text`/`.output`, inside a
 * `content: [{ text }]` array, or as a nested/escaped object. We scan every
 * stringy field we can find, prefer a clean JSON object with the literal keys,
 * and finally regex-scan the raw text for the child session-key pattern so a
 * wrapping envelope can never hide it.
 */
function extractAcceptedSpawn(payload: unknown): AcceptedSpawn {
  const blobs: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) blobs.push(v);
  };
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    push(p['text']);
    push(p['output']);
    const content = p['content'];
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && typeof c === 'object') push((c as Record<string, unknown>)['text']);
        else push(c);
      }
    }
    try {
      blobs.push(JSON.stringify(payload));
    } catch {
      // ignore non-serialisable payloads
    }
  } else {
    push(payload);
  }

  let runId: string | undefined;
  let childSessionKey: string | undefined;

  // Prefer a clean JSON object carrying the literal keys.
  for (const b of blobs) {
    const parsed = tryParseObject(b);
    if (!parsed) continue;
    if (!runId && typeof parsed['runId'] === 'string') runId = parsed['runId'] as string;
    if (!childSessionKey && typeof parsed['childSessionKey'] === 'string')
      childSessionKey = parsed['childSessionKey'] as string;
  }

  // Regex fallbacks over the raw blobs (handles nested / escaped envelopes).
  if (!childSessionKey || !runId) {
    const joined = blobs.join('\n');
    if (!childSessionKey) {
      const m = CHILD_SESSION_KEY_RE.exec(joined);
      if (m) childSessionKey = m[0];
    }
    if (!runId) {
      const m = /"runId"\s*:\s*"([^"]+)"/.exec(joined);
      if (m) runId = m[1];
    }
  }

  return {
    ...(runId ? { runId } : {}),
    ...(childSessionKey ? { childSessionKey } : {}),
  };
}

/**
 * Record the inbound (user) turn in the host session store *before* the reply
 * is dispatched, mirroring what every built-in channel does. OpenClaw's own
 * direct-message pipeline (`dispatchInboundDirectDmWithRuntime`) always runs
 * `resolveAgentRoute` → `resolveStorePath` → `recordInboundSession` →
 * `dispatchReplyWithBufferedBlockDispatcher`; the buffered block dispatcher only
 * *mirrors the assistant reply* into an already-recorded session entry and does
 * not, on its own, create the durable per-`SessionKey` entry (session id +
 * route/origin metadata) that the host reloads on the next launch and that
 * gateway/ACP session discovery scans on disk.
 *
 * Our channel drove turns straight through the dispatcher and skipped this
 * step, so nothing durable was written for the conversation: every OpenClaw
 * restart reloaded an empty session and the agent "forgot" the thread — even
 * though the `SessionKey` we send was byte-identical across runs. The upsert is
 * idempotent and keyed identically, so recording it here makes the session
 * survive a shutdown without changing the key.
 *
 * Best-effort: guarded so a runtime that does not expose the session surface
 * (older hosts, unit-test doubles) simply skips recording instead of failing
 * the turn.
 */
async function recordInboundSessionForTurn(params: {
  runtime: any;
  api: OpenClawApi;
  cfg: unknown;
  sessionKey: string;
  ctx: unknown;
  agentId: string | undefined;
}): Promise<void> {
  const { runtime, api, cfg, sessionKey, ctx, agentId } = params;
  const session = runtime?.channel?.session;
  const record = session?.recordInboundSession;
  const resolveStorePath = session?.resolveStorePath;
  if (typeof record !== 'function' || typeof resolveStorePath !== 'function') return;
  try {
    const store = (cfg as { session?: { store?: string } } | undefined)?.session?.store;
    // The store path must resolve to the SAME agent the host runs/persists this
    // turn under, so pass the resolved route's `agentId` (falls back to the
    // host default when absent — matching how the dispatcher resolves it).
    const storePath = resolveStorePath.call(
      session,
      store,
      agentId !== undefined ? { agentId } : undefined,
    );
    if (typeof storePath !== 'string' || storePath.length === 0) return;
    await record.call(session, {
      storePath,
      sessionKey,
      ctx,
      // Create the entry when this is the conversation's first turn — otherwise
      // there is nothing on disk to reload after a restart.
      createIfMissing: true,
      onRecordError: (err: unknown) => {
        safeLog(
          api,
          'warn',
          `[ac2] failed to record inbound session (sessionKey=${sessionKey}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    });
  } catch (err) {
    safeLog(
      api,
      'warn',
      `[ac2] could not record inbound session (sessionKey=${sessionKey}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export async function routeInboundToAgent(
  api: OpenClawApi,
  text: string,
  transport: Sendable,
  controllerDid: string,
  requestId?: string,
): Promise<void> {
  const parsed = parseInboundChat(text);
  const messageText = parsed.text;
  const thid = parsed.explicitThid ? parsed.thid : getActiveConversation(controllerDid, requestId);
  safeLog(api, 'info', `Received chat from wallet (thid=${thid}): ${messageText}`);

  const trimmed = messageText.trim();
  if (trimmed.length === 0) return;

  if (requestId) {
    recordConversationMessage(requestId, thid, {
      role: 'user',
      text: trimmed,
      at: Date.now(),
    });
  }

  const runtime = getActiveRuntime() ?? (api.runtime as any);
  const dispatch = runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (typeof dispatch !== 'function') {
    safeLog(
      api,
      'warn',
      '[ac2] no OpenClaw runtime reply dispatcher available — cannot route message to agent',
    );
    return;
  }

  const cfg = api.config;
  // Build the OpenClaw session key with the SAME canonical rule the outbound
  // route + session resolution use (`buildAc2SessionKey`), so the default
  // thread collapses to the bare `ac2:<controllerDid>` key instead of
  // `ac2:<controllerDid>:default`. Keying it consistently is what lets the host
  // reload the same persisted agent session on every (re)connect rather than
  // splitting the conversation across two keys and losing its context.
  const sessionKey = buildAc2SessionKey(controllerDid, thid);
  const messageSid = `ac2-${Date.now()}`;

  let agentReply = '';
  let previewText = '';
  let toolActivitySeq = 0;
  // True once this turn delegated work via `sessions_spawn`, so a turn that
  // ends on `sessions_yield` with no assistant text is reported as "working"
  // instead of silently discarded.
  let spawnedThisTurn = false;
  // Tasks spawned during this turn; each gets a background completion watcher
  // once the turn settles so its result is delivered back to the wallet.
  const spawnedTaskThids = new Set<string>();

  const toolCardIds = new Map<string, string>();
  const toolCommands = new Map<string, string>();
  const toolOutputs = new Map<string, string>();
  const toolCardId = (key: string | undefined): string => {
    const k = key && key.length > 0 ? key : `seq-${toolActivitySeq++}`;
    let id = toolCardIds.get(k);
    if (!id) {
      id = `${messageSid}-tool-${k}`;
      toolCardIds.set(k, id);
    }
    return id;
  };
  const formatToolCommand = (args: unknown): string | undefined => {
    if (!args || typeof args !== 'object') return undefined;
    const a = args as Record<string, unknown>;
    if (typeof a.command === 'string') return a.command;
    if (Array.isArray(a.command)) return a.command.join(' ');
    if (typeof a.cmd === 'string') return a.cmd;
    if (typeof a.script === 'string') return a.script;
    if (typeof a.path === 'string') return a.path;
    if (typeof a.file === 'string') return a.file;
    try {
      const json = JSON.stringify(a);
      return json && json !== '{}' ? json : undefined;
    } catch {
      return undefined;
    }
  };
  // Tolerant of delta chunks (append) and cumulative snapshots (replace).
  const mergeToolOutput = (key: string, chunk: string): string => {
    const prev = toolOutputs.get(key) ?? '';
    let next: string;
    if (prev.length === 0) next = chunk;
    else if (chunk.startsWith(prev))
      next = chunk; // cumulative snapshot
    else if (prev.endsWith(chunk))
      next = prev; // duplicate tail
    else next = prev + chunk; // delta
    toolOutputs.set(key, next);
    return next;
  };
  const MAX_TOOL_OUTPUT = 8000;
  const capToolOutput = (out: string): string =>
    out.length > MAX_TOOL_OUTPUT
      ? `${out.slice(0, MAX_TOOL_OUTPUT)}\n… (${out.length - MAX_TOOL_OUTPUT} more chars)`
      : out;
  const emitToolCard = (
    key: string,
    fields: { name?: string; command?: string; output?: string },
  ): void => {
    const id = toolCardId(key);
    if (transport != null) {
      sendToolActivity(transport, thid, {
        id,
        ...(fields.name ? { name: fields.name } : {}),
        ...(fields.command ? { command: fields.command } : {}),
        ...(fields.output !== undefined ? { output: fields.output } : {}),
      });
    }
    if (requestId) {
      recordToolActivity(requestId, thid, {
        id,
        ...(fields.name ? { name: fields.name } : {}),
        ...(fields.command ? { command: fields.command } : {}),
        ...(fields.output !== undefined ? { output: fields.output } : {}),
      });
    }
  };

  // Emit/refresh a self-contained background-task card (de-duped by a stable
  // per-task id) over the stream transport and persist it to history. The
  // spawning turn uses this for the initial `running` card; the completion path
  // re-emits the same id from `channel/task-card.ts`.
  const emitTaskCard = (
    task: Ac2Task,
    status: 'running' | 'completed' | 'failed' | 'stopped',
    result?: string,
  ): void => {
    const id = taskCardId(task.taskThid);
    const cardTitle = taskDisplayTitle(task);
    const prompt = task.task;
    const card = {
      id,
      title: cardTitle,
      status,
      ...(prompt && prompt.length > 0 ? { prompt } : {}),
      ...(result !== undefined ? { result } : {}),
    };
    if (transport != null) sendTaskCard(transport, thid, card);
    if (requestId) recordTaskActivity(requestId, thid, card);
  };

  // Render a `sessions_spawn` tool call as a first-class background task card
  // inline in the parent thread. The task is tracked so its completion can be
  // delivered back here later; we no longer seed a dedicated `task-<name>`
  // conversation (the app surfaces background work via its task indicator in
  // the parent thread). Returns true when the tool was a sub-session tool (so
  // the generic tool-card path is skipped).
  const handleSubSessionTool = (
    name: string | undefined,
    key: string | undefined,
    args: Record<string, unknown> | undefined,
    resultText?: string,
  ): boolean => {
    if (name === TOOL_SESSIONS_SPAWN) {
      const a = args ?? {};
      const taskText = typeof a['task'] === 'string' ? (a['task'] as string) : '';
      const taskName = typeof a['taskName'] === 'string' ? (a['taskName'] as string) : undefined;
      const label = typeof a['label'] === 'string' ? (a['label'] as string) : undefined;
      const agentId = typeof a['agentId'] === 'string' ? (a['agentId'] as string) : undefined;
      const task = registerTask({
        parentThid: thid,
        parentSessionKey: sessionKey,
        task: taskText,
        ...(taskName !== undefined ? { taskName } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
      });
      spawnedThisTurn = true;
      spawnedTaskThids.add(task.taskThid);
      // Enrich with the accepted `{ runId, childSessionKey }` when present.
      const accepted = extractAcceptedSpawn(resultText);
      if (accepted.runId !== undefined || accepted.childSessionKey !== undefined) {
        attachSpawnResult(task.taskThid, accepted);
      }
      // Render a self-contained background-task card in `running` state. Its
      // completion path (the poller / `subagent_ended`) later re-emits the SAME
      // card id with a terminal status + the child's result text inline, so the
      // one card flips from running to done rather than leaving a stale
      // "running…" card plus a disconnected reply bubble.
      emitTaskCard(task, 'running');
      return true;
    }
    if (name === TOOL_SESSIONS_YIELD) {
      // Yield ends the turn; keep the thread visibly "working" rather than
      // letting it fall silent while children run.
      streamPreview('thinking');
      emitToolCard(key ?? 'yield', {
        name: '⏳ awaiting background task',
        output: 'Delegated work is running; results will post here when ready.',
      });
      return true;
    }
    return false;
  };

  // Resolve the host agent route for this controller so the inbound session is
  // recorded (and later reloaded) under the SAME agent + session store the host
  // runs the turn in. The route is otherwise advisory here, so tolerate older
  // runtimes that do not expose it.
  let routeAgentId: string | undefined;
  try {
    const route = runtime.channel?.routing?.resolveAgentRoute?.({
      cfg,
      channel: CHANNEL_ID,
      accountId: controllerDid,
      peer: { kind: 'direct', id: controllerDid },
    });
    if (route && typeof (route as { agentId?: unknown }).agentId === 'string') {
      routeAgentId = (route as { agentId: string }).agentId;
    }
  } catch {
    // routing is advisory
  }

  const ctx = {
    Body: trimmed,
    BodyForAgent: trimmed,
    RawBody: text,
    From: controllerDid,
    // Agent DID comes from the bootstrap KeyRequest, not config.
    To: sessionManager.getActive()?.agentDid ?? 'did:ac2:agent',
    SessionKey: sessionKey,
    AccountId: controllerDid,
    MessageSid: messageSid,
    // Anchor persistence to the resolved agent so `recordInboundSession` and the
    // dispatcher's own store lookup agree on the `agents/<agentId>/` store.
    ...(routeAgentId !== undefined ? { AgentId: routeAgentId } : {}),
  };

  safeLog(api, 'info', `[ac2] dispatching wallet message to agent (sessionKey=${sessionKey})`);

  // Persist the inbound turn before dispatching so the conversation survives an
  // OpenClaw restart (see `recordInboundSessionForTurn`).
  await recordInboundSessionForTurn({ runtime, api, cfg, sessionKey, ctx, agentId: routeAgentId });

  sendPreview(transport, thid, 'thinking');

  let agentReplyPersisted = false;
  const finalReplyText = (): string => (agentReply.length > 0 ? agentReply : previewText);
  const persistAgentReply = (): void => {
    if (agentReplyPersisted) return;
    agentReplyPersisted = true;
    const replyText = finalReplyText();
    if (!requestId || replyText.length === 0) return;
    recordConversationMessage(requestId, thid, {
      role: 'agent',
      text: replyText,
      at: Date.now(),
    });
  };

  // Set when the agent turn fails (e.g. a provider quota / rate-limit error).
  // Its presence flips `settle` from a silent discard to delivering a real
  // error message back to the client.
  let turnError: Ac2AgentError | undefined;

  let settled = false;
  const streamPreview = (phase: Ac2LivePhase, opts?: { text?: string; detail?: string }): void => {
    if (settled) return;
    sendPreview(transport, thid, phase, opts);
  };
  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (turnError !== undefined) {
      // The agent turn failed (most commonly a provider quota / rate-limit
      // error). Deliver the classified error to the client as the turn's reply
      // instead of silently discarding the "thinking" preview — otherwise the
      // wallet is left spinning with no idea the turn failed. Also raise an
      // out-of-band notice banner so the wallet can special-case it (e.g. a
      // quota warning). Any partial text the agent managed to stream is kept,
      // with the error appended after it.
      const partial = finalReplyText();
      const errorText =
        partial.length > 0 ? `${partial}\n\n${turnError.text}` : turnError.text;
      sendFinalize(transport, thid, messageSid, errorText);
      if (requestId) {
        recordConversationMessage(requestId, thid, {
          role: 'agent',
          text: errorText,
          at: Date.now(),
        });
      }
      sendNotice(transport, { code: turnError.code, level: 'error', text: turnError.text });
      safeLog(api, 'info', `[ac2] delivered agent-error reply to wallet (code=${turnError.code}).`);
      for (const taskThid of spawnedTaskThids) watchTaskCompletion(taskThid);
      return;
    }
    persistAgentReply();
    const replyText = finalReplyText();
    if (replyText.length > 0) {
      sendFinalize(transport, thid, messageSid, replyText);
      safeLog(api, 'info', `[ac2] Finalized agent reply to wallet (len=${replyText.length})`);
    } else if (spawnedThisTurn) {
      // The turn delegated work and yielded without composing a reply. Post a
      // durable "working" note so the thread isn't left silent; the child's
      // result arrives later on its own host-initiated turn.
      const note =
        'Working on that in the background \u2014 I\'ll post the result here as soon as the task finishes.';
      sendFinalize(transport, thid, messageSid, note);
      if (requestId) {
        recordConversationMessage(requestId, thid, { role: 'agent', text: note, at: Date.now() });
      }
      safeLog(api, 'info', '[ac2] turn yielded to background task(s); posted working note.');
    } else {
      sendDiscard(transport, thid);
    }
    // Watch every task spawned this turn until its child session finishes, then
    // deliver the real result into this thread ourselves. The host's own
    // announce can't reach our no-gateway CLI and the `subagent_ended` hook
    // never fires here, so this poll-based watcher is the reliable path (see
    // `watchTaskCompletion`).
    for (const taskThid of spawnedTaskThids) watchTaskCompletion(taskThid);
  };

  try {
    await dispatch.call(runtime.channel.reply, {
      ctx,
      cfg,
      dispatcherOptions: {
        onReplyStart: (): void => {
          streamPreview('thinking');
        },
        deliver: async (payload: any, info: any): Promise<void> => {
          const kind = info?.kind;
          if (payload?.isReasoning) {
            streamPreview('thinking');
            return;
          }
          if (kind === 'tool') {
            const toolName =
              typeof info?.name === 'string'
                ? info.name
                : typeof payload?.toolName === 'string'
                  ? payload.toolName
                  : typeof payload?.name === 'string'
                    ? payload.name
                    : undefined;
            // Sub-session tools render as durable task cards (see onToolStart);
            // keep the transient spinner generic instead of flashing the raw
            // `sessions_spawn` / `sessions_yield` name.
            if (toolName === TOOL_SESSIONS_SPAWN || toolName === TOOL_SESSIONS_YIELD) {
              streamPreview('thinking');
              return;
            }
            streamPreview('tool', toolName ? { detail: toolName } : undefined);
            return;
          }
          const replyText = typeof payload?.text === 'string' ? payload.text : '';
          if (replyText.length === 0) return;
          agentReply += replyText;
          streamPreview('typing', { text: agentReply });
        },
        onIdle: (): void => {
          settle();
        },
        onCleanup: (): void => {
          settle();
        },
        onError: (err: unknown): void => {
          const msg = err instanceof Error ? err.message : String(err);
          // Classify the failure (quota-aware) and set it BEFORE settling so the
          // client receives a real error message instead of a silent discard.
          if (turnError === undefined) turnError = classifyAgentError(err);
          settle();
          safeLog(api, 'warn', `[ac2] agent reply dispatcher error: ${msg}`);
        },
      },
      // Low-level run events drive the live preview between block boundaries.
      replyOptions: {
        suppressDefaultToolProgressMessages: true,
        onPartialReply: (payload: any): void => {
          if (payload?.replace === true) {
            previewText = typeof payload.text === 'string' ? payload.text : '';
          } else if (typeof payload?.delta === 'string') {
            previewText += payload.delta;
          } else if (typeof payload?.text === 'string') {
            previewText = payload.text;
          }
          if (previewText.length > 0) {
            streamPreview('typing', { text: previewText });
          }
        },
        onReasoningStream: (): void => {
          streamPreview('thinking');
        },
        onToolStart: (payload: {
          itemId?: string;
          toolCallId?: string;
          name?: string;
          args?: Record<string, unknown>;
        }): void => {
          const detail = typeof payload?.name === 'string' ? payload.name : undefined;
          const key =
            payload?.toolCallId ?? payload?.itemId ?? (detail ? `name:${detail}` : undefined);
          if (handleSubSessionTool(detail, key ?? undefined, payload?.args)) return;
          streamPreview('tool', detail ? { detail } : undefined);
          if (key == null) return;
          const command = formatToolCommand(payload?.args);
          if (command) toolCommands.set(key, command);
          emitToolCard(key, {
            ...(detail ? { name: detail } : {}),
            ...(command ? { command } : {}),
          });
        },
        onCommandOutput: (payload: {
          itemId?: string;
          toolCallId?: string;
          name?: string;
          output?: string;
          status?: string;
          exitCode?: number | null;
          durationMs?: number;
        }): void => {
          const key = payload?.toolCallId ?? payload?.itemId;
          if (key == null) return;
          let accumulated = toolOutputs.get(key) ?? '';
          if (typeof payload?.output === 'string' && payload.output.length > 0) {
            accumulated = mergeToolOutput(key, payload.output);
          }
          const done =
            payload?.status === 'completed' ||
            payload?.status === 'failed' ||
            payload?.status === 'error' ||
            typeof payload?.exitCode === 'number';
          let output = capToolOutput(accumulated);
          if (done && typeof payload?.exitCode === 'number') {
            output = `${output}${output.length > 0 ? '\n' : ''}[exit ${payload.exitCode}]`;
          }
          const cmd = toolCommands.get(key);
          emitToolCard(key, {
            ...(typeof payload?.name === 'string' ? { name: payload.name } : {}),
            ...(cmd ? { command: cmd } : {}),
            ...(output.length > 0 ? { output } : {}),
          });
        },
        onToolResult: (payload: any): void => {
          const toolName = typeof payload?.name === 'string' ? payload.name : undefined;
          if (toolName === TOOL_SESSIONS_SPAWN) {
            // Enrich the task registered at spawn-start with the accepted
            // `{ runId, childSessionKey }` envelope; never render it raw. Pass
            // the whole payload so the extractor can dig the key out of any
            // envelope shape (text / output / content[] / nested JSON).
            const accepted = extractAcceptedSpawn(payload);
            const pending = findPendingTaskForParent(thid);
            if (
              pending &&
              (accepted.runId !== undefined || accepted.childSessionKey !== undefined)
            ) {
              attachSpawnResult(pending.taskThid, accepted);
              safeLog(
                api,
                'info',
                `[ac2] captured background task spawn (child=${accepted.childSessionKey ?? '?'}, run=${accepted.runId ?? '?'}).`,
              );
            } else if (!pending) {
              safeLog(
                api,
                'warn',
                '[ac2] sessions_spawn result had no pending task to enrich; completion polling may not start.',
              );
            } else {
              safeLog(
                api,
                'warn',
                '[ac2] sessions_spawn result did not carry a childSessionKey; completion polling cannot locate the child session.',
              );
            }
            return;
          }
          if (toolName === TOOL_SESSIONS_YIELD) return;
          const key =
            typeof payload?.toolCallId === 'string'
              ? payload.toolCallId
              : typeof payload?.itemId === 'string'
                ? payload.itemId
                : undefined;
          if (key == null) return;
          const chunk = typeof payload?.text === 'string' ? payload.text : '';
          if (chunk.length === 0) return;
          const accumulated = mergeToolOutput(key, chunk);
          const cmd = toolCommands.get(key);
          emitToolCard(key, {
            ...(typeof payload?.name === 'string' ? { name: payload.name } : {}),
            ...(cmd ? { command: cmd } : {}),
            output: capToolOutput(accumulated),
          });
        },
        onPatchSummary: (payload: {
          itemId?: string;
          toolCallId?: string;
          name?: string;
          added?: string[];
          modified?: string[];
          deleted?: string[];
          summary?: string;
        }): void => {
          const key = payload?.toolCallId ?? payload?.itemId ?? `patch-${toolActivitySeq}`;
          const lines: string[] = [];
          for (const f of payload?.added ?? []) lines.push(`+ ${f}`);
          for (const f of payload?.modified ?? []) lines.push(`~ ${f}`);
          for (const f of payload?.deleted ?? []) lines.push(`- ${f}`);
          const output =
            lines.length > 0
              ? lines.join('\n')
              : typeof payload?.summary === 'string'
                ? payload.summary
                : '';
          if (output.length === 0) return;
          emitToolCard(key, {
            name: typeof payload?.name === 'string' ? payload.name : 'patch',
            output: capToolOutput(output),
          });
        },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A throw from the dispatch call itself (rather than via onError) must also
    // reach the client as an error message, not a silent discard.
    if (turnError === undefined) turnError = classifyAgentError(err);
    settle();
    safeLog(api, 'error', `[ac2] failed to route message to agent: ${msg}`);
  }
}

let agentWarmedUp = false;

/** Pre-load the agent runtime via a throwaway dispatch (best-effort, once per process). */
export async function warmUpAgent(api: OpenClawApi, controllerDid: string): Promise<void> {
  if (agentWarmedUp) return;
  agentWarmedUp = true;

  const runtime = getActiveRuntime() ?? (api.runtime as any);
  const dispatch = runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (typeof dispatch !== 'function') {
    return;
  }

  const cfg = api.config;
  const sessionKey = `${CHANNEL_ID}:__warmup__`;
  const ctx = {
    Body: 'ping',
    BodyForAgent: 'ping',
    RawBody: 'ping',
    From: controllerDid,
    To: sessionManager.getActive()?.agentDid ?? 'did:ac2:agent',
    SessionKey: sessionKey,
    AccountId: controllerDid,
    MessageSid: `ac2-warmup-${Date.now()}`,
  };

  safeLog(api, 'info', '[ac2] Warming up agent runtime (pre-loading model/tools)…');

  try {
    await dispatch.call(runtime.channel.reply, {
      ctx,
      cfg,
      dispatcherOptions: {
        deliver: async (): Promise<void> => {},
        onError: (): void => {},
      },
    });
    safeLog(api, 'info', '[ac2] Agent runtime warmed up — first reply will skip cold start.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    safeLog(api, 'warn', `[ac2] agent warm-up failed (non-fatal): ${msg}`);
  }
}
