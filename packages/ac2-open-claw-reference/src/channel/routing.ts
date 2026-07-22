/** Inbound chat routing: wallet → OpenClaw agent → wallet. */

import { CHANNEL_ID, getActiveRuntime, safeLog, type OpenClawApi } from '../runtime.js';
import {
  ensureConversation,
  recordConversationMessage,
  recordToolActivity,
} from '../identity/state.js';
import { sessionManager } from '../session/manager.js';
import {
  sendDiscard,
  sendFinalize,
  sendPreview,
  sendToolActivity,
  type Ac2LivePhase,
  type Sendable,
} from './stream.js';
import {
  getActiveConversation,
  parseInboundChat,
  replayConversationList,
} from './conversation.js';
import {
  attachSpawnResult,
  findPendingTaskForParent,
  registerTask,
  taskDisplayTitle,
} from './tasks.js';

/** Built-in host tool that starts an isolated background sub-agent run. */
const TOOL_SESSIONS_SPAWN = 'sessions_spawn';
/** Built-in host tool that ends the turn to await sub-agent completions. */
const TOOL_SESSIONS_YIELD = 'sessions_yield';

/** Extract `{ runId, childSessionKey }` from an accepted `sessions_spawn` result. */
function parseAcceptedSpawn(text: string | undefined): {
  runId?: string;
  childSessionKey?: string;
} {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      ...(typeof parsed['runId'] === 'string' ? { runId: parsed['runId'] } : {}),
      ...(typeof parsed['childSessionKey'] === 'string'
        ? { childSessionKey: parsed['childSessionKey'] }
        : {}),
    };
  } catch {
    return {};
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
  const sessionKey = `${CHANNEL_ID}:${controllerDid}:${thid}`;
  const messageSid = `ac2-${Date.now()}`;

  let agentReply = '';
  let previewText = '';
  let toolActivitySeq = 0;
  // True once this turn delegated work via `sessions_spawn`, so a turn that
  // ends on `sessions_yield` with no assistant text is reported as "working"
  // instead of silently discarded.
  let spawnedThisTurn = false;

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

  // Render a `sessions_spawn` tool call as a first-class background task:
  // register it, seed a dedicated `task-<name>` thread, refresh the wallet's
  // conversation list, and card it in the parent thread. Returns true when the
  // tool was a sub-session tool (so the generic tool-card path is skipped).
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
        task: taskText,
        ...(taskName !== undefined ? { taskName } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
      });
      spawnedThisTurn = true;
      const title = taskDisplayTitle(task);
      // Enrich with the accepted `{ runId, childSessionKey }` when present.
      const accepted = parseAcceptedSpawn(resultText);
      if (accepted.runId !== undefined || accepted.childSessionKey !== undefined) {
        attachSpawnResult(task.taskThid, accepted);
      }
      // Materialize the task's own thread and seed the delegated prompt so the
      // wallet can open `task-<name>` and see what was requested.
      if (requestId) {
        ensureConversation(requestId, task.taskThid, title);
        if (taskText.length > 0) {
          recordConversationMessage(requestId, task.taskThid, {
            role: 'user',
            text: taskText,
            at: Date.now(),
          });
        }
        replayConversationList(transport, requestId);
      }
      emitToolCard(key ?? `spawn:${task.taskThid}`, {
        name: `🧵 task · ${title}`,
        ...(taskText.length > 0 ? { command: taskText } : {}),
        output: `Started background task \`${task.taskThid}\` — running…`,
      });
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

  try {
    runtime.channel?.routing?.resolveAgentRoute?.({
      cfg,
      channel: CHANNEL_ID,
      accountId: controllerDid,
      peer: { kind: 'direct', id: controllerDid },
    });
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
  };

  safeLog(api, 'info', `[ac2] dispatching wallet message to agent (sessionKey=${sessionKey})`);

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

  let settled = false;
  const streamPreview = (phase: Ac2LivePhase, opts?: { text?: string; detail?: string }): void => {
    if (settled) return;
    sendPreview(transport, thid, phase, opts);
  };
  const settle = (): void => {
    if (settled) return;
    settled = true;
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
            // `{ runId, childSessionKey }` envelope; never render it raw.
            const accepted = parseAcceptedSpawn(
              typeof payload?.text === 'string' ? payload.text : undefined,
            );
            const pending = findPendingTaskForParent(thid);
            if (
              pending &&
              (accepted.runId !== undefined || accepted.childSessionKey !== undefined)
            ) {
              attachSpawnResult(pending.taskThid, accepted);
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
    settle();
    const msg = err instanceof Error ? err.message : String(err);
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
