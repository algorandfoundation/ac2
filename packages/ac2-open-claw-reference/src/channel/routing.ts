/** Inbound chat routing: wallet → OpenClaw agent → wallet. */

import { CHANNEL_ID, getActiveRuntime, safeLog, type OpenClawApi } from '../runtime.js';
import { recordConversationMessage, recordToolActivity } from '../identity/state.js';
import { sessionManager } from '../session/manager.js';
import {
  sendDiscard,
  sendFinalize,
  sendPreview,
  sendToolActivity,
  type Ac2LivePhase,
  type Sendable,
} from './stream.js';
import { getActiveConversation, parseInboundChat } from './conversation.js';

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
          streamPreview('tool', detail ? { detail } : undefined);
          const key =
            payload?.toolCallId ?? payload?.itemId ?? (detail ? `name:${detail}` : undefined);
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
