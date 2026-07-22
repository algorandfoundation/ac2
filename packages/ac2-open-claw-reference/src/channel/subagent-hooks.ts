/**
 * Reliable sub-agent ("background task") lifecycle via the OpenClaw host's
 * plugin-hook surface.
 *
 * A `sessions_spawn` child runs in its own isolated session and, when it
 * finishes, the host tries to push its result back to the *requester* thread.
 * In our standalone pairing CLI (no in-process gateway) that host-driven
 * delivery is unreliable for any non-default thread: the direct-completion
 * fallback refuses targets that carry a `threadId`, and the announce-agent path
 * needs a driven turn we never run. The net effect the user sees is a task that
 * "completes without any response" even though the agent promised to follow up.
 *
 * The host also exposes an in-process hook surface that fires regardless of the
 * gateway: `subagent_spawned` when a child launches and `subagent_ended` when it
 * finishes. We subscribe to both. `subagent_spawned` lets us bind the host's
 * authoritative `{ runId, childSessionKey }` to the task we registered from the
 * `sessions_spawn` tool call, and `subagent_ended` lets us post the completion
 * follow-up into the parent conversation ourselves — the missing "I'll let you
 * know when it's done" message.
 *
 * The `subagent_ended` event itself does NOT carry the child's final result
 * *text*, but the child persists that text to its own session transcript, which
 * the public plugin SDK lets us read. So on completion we fetch the real answer
 * (via `readChildResultText`) and post it into the parent conversation — the
 * follow-up the agent promised. If the text can't be read we fall back to a
 * plain lifecycle notice (finished / failed / stopped). Everything is delivered
 * into the parent thread the work was requested from; we no longer split
 * background work into dedicated `task-…` threads (the app renders the task
 * inline via its status indicator).
 */

import { CHANNEL_ID, getActiveApi, safeLog, type OpenClawApi } from '../runtime.js';
import { sessionManager } from '../session/manager.js';
import { recordConversationMessage } from '../identity/state.js';
import { sendFinalize, type Sendable } from './stream.js';
import { emitTaskCardUpdate } from './task-card.js';
import { DEFAULT_THID, resolveAc2SessionConversation } from './conversation.js';
import {
  describeSubagentCandidates,
  discoverChildSessionKey,
  readChildResultText,
  readChildSessionStatus,
} from './subagent-result.js';
import {
  attachSpawnResult,
  findPendingTaskForParent,
  findTaskByRun,
  getTaskByThid,
  listTasks,
  markTaskResult,
  registerTask,
  taskDisplayTitle,
  type Ac2Task,
} from './tasks.js';

/** Plugin-hook name: a sub-agent run has launched. */
const HOOK_SUBAGENT_SPAWNED = 'subagent_spawned';
/** Plugin-hook name: a sub-agent run has finished (ok/error/timeout/…). */
const HOOK_SUBAGENT_ENDED = 'subagent_ended';

/** Non-empty-string coercion. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Coerce a `threadId` (string | number) into a wallet thread id. */
function thidFrom(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const api = getActiveApi();
  if (api) safeLog(api, level, msg);
}

/**
 * `subagent_spawned` handler. Binds the host's authoritative
 * `{ runId, childSessionKey }` to the task we registered from the
 * `sessions_spawn` tool call so `subagent_ended` can find it later. Falls back
 * to registering a task if the tool-call path missed it (e.g. the accepted
 * envelope did not parse), using the requester thread the host reports.
 *
 * Event shape (host): `{ runId, childSessionKey, agentId?, label?, requester?:
 * { channel, accountId, to, threadId } , … }`; ctx: `{ runId, childSessionKey,
 * requesterSessionKey }`.
 */
export function handleSubagentSpawned(event: unknown, ctx?: unknown): void {
  const e = (event ?? {}) as Record<string, unknown>;
  const c = (ctx ?? {}) as Record<string, unknown>;
  const runId = str(c['runId']) ?? str(e['runId']);
  const childSessionKey = str(c['childSessionKey']) ?? str(e['childSessionKey']);
  const agentId = str(e['agentId']);
  const label = str(e['label']);
  const requester = (e['requester'] ?? {}) as Record<string, unknown>;
  const parentThid = thidFrom(requester['threadId']);

  // Prefer correlating to the task routing already registered from the tool
  // call (it carries the real task prompt + display title); enrich it with the
  // authoritative ids so the ended hook can locate it deterministically.
  let task = findTaskByRun({
    ...(runId !== undefined ? { runId } : {}),
    ...(childSessionKey !== undefined ? { childSessionKey } : {}),
  });
  if (!task && parentThid) task = findPendingTaskForParent(parentThid);

  if (task) {
    attachSpawnResult(task.taskThid, {
      ...(runId !== undefined ? { runId } : {}),
      ...(childSessionKey !== undefined ? { childSessionKey } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
    });
    return;
  }

  // Backstop: the tool path did not register a task; create one from the hook.
  // The task prompt text is not available on this event, so leave it empty.
  registerTask({
    parentThid: parentThid ?? DEFAULT_THID,
    task: '',
    ...(label !== undefined ? { label } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(childSessionKey !== undefined ? { childSessionKey } : {}),
  });
}

/**
 * Build the user-facing lifecycle notice for a finished task. `title` is the
 * task's display title when we tracked one; omitted for untracked runs (we
 * still deliver a generic notice so the promised follow-up is never silent).
 */
function completionMessage(
  title: string | undefined,
  kind: 'completed' | 'failed' | 'stopped',
  errorText?: string,
): string {
  const named = title ? `\u201c${title}\u201d ` : '';
  if (kind === 'completed') {
    return `\u2705 Background task ${named}finished.`;
  }
  if (kind === 'stopped') {
    return `\u23f9\ufe0f Background task ${named}was stopped.`;
  }
  return `\u274c Background task ${named}failed${errorText ? `: ${errorText}` : '.'}`;
}

/**
 * `subagent_ended` handler. Correlates the finished run to a tracked task,
 * flips its lifecycle, and posts the follow-up into the parent conversation the
 * work was requested from — the child's real result text when we can read it,
 * otherwise a plain lifecycle notice. Best-effort and never throws (hooks are
 * fire-and-forget). Async so it can read the child's transcript.
 *
 * Event shape (host): `{ targetSessionKey, targetKind, reason, runId?, endedAt?,
 * outcome?, error? }`; ctx: `{ runId, childSessionKey, requesterSessionKey }`.
 */
export async function handleSubagentEnded(event: unknown, ctx?: unknown): Promise<void> {
  try {
    const e = (event ?? {}) as Record<string, unknown>;
    const c = (ctx ?? {}) as Record<string, unknown>;
    const runId = str(c['runId']) ?? str(e['runId']);
    const childSessionKey = str(c['childSessionKey']) ?? str(e['targetSessionKey']);
    const requesterSessionKey = str(c['requesterSessionKey']) ?? str(e['requesterSessionKey']);
    const outcome = str(e['outcome']);
    const reason = str(e['reason']);
    const errorText = str(e['error']);

    // Evidence line: proves the in-process hook actually fired for this run
    // (the host only emits `subagent_ended` when a listener is registered).
    log(
      'info',
      `[ac2] subagent_ended fired (runId=${runId ?? '?'}, child=${childSessionKey ?? '?'}, ` +
        `outcome=${outcome ?? 'ok'}, reason=${reason ?? '-'}).`,
    );

    // Internal lifecycle churn (session reset / deletion) is not a user-visible
    // task completion — ignore it.
    if (reason === 'reset' || reason === 'deleted') return;

    const kind: 'completed' | 'failed' | 'stopped' =
      outcome === 'error' || outcome === 'timeout' || reason === 'killed'
        ? reason === 'killed'
          ? 'stopped'
          : 'failed'
        : 'completed';

    // On success, deliver the child's actual answer read from its own session
    // transcript; failed/stopped runs (or an unreadable transcript) fall back to
    // a plain lifecycle notice. Used by both the tracked and untracked paths.
    const resolveResult = async (
      key: string | undefined,
      agentId: string | undefined,
    ): Promise<string | undefined> => {
      if (kind !== 'completed') return undefined;
      return readChildResultText({
        ...(key !== undefined ? { childSessionKey: key } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
      });
    };

    const task = findTaskByRun({
      ...(runId !== undefined ? { runId } : {}),
      ...(childSessionKey !== undefined ? { childSessionKey } : {}),
    });

    if (task) {
      if (task.status !== 'running') return; // already reconciled (e.g. deliverAgentText)
      let message = completionMessage(taskDisplayTitle(task), kind, errorText);
      const resultText = await resolveResult(task.childSessionKey ?? childSessionKey, task.agentId);
      if (resultText) message = resultText;
      // Re-check: a concurrent path (poller / direct delivery) may have
      // reconciled the task while we awaited the transcript read.
      const fresh = getTaskByThid(task.taskThid);
      if (!fresh || fresh.status !== 'running') return;
      markTaskResult(task.taskThid, kind, message);
      // Flip the running task card in place to its terminal state with the
      // child's result inline (no separate reply bubble).
      emitTaskCardUpdate({ thid: task.parentThid, task, status: kind, result: message });
      log('info', `[ac2] delivered subagent_ended task card into \`${task.parentThid}\` (${kind}).`);
      return;
    }

    // No task was tracked for this run — e.g. the `sessions_spawn` tool-result
    // envelope did not parse and the `subagent_spawned` hook never bound it.
    // Deliver anyway so the agent's promised follow-up is never silently
    // dropped: derive the parent thread from the requester session key and read
    // the child's answer straight from its transcript. Only handle runs whose
    // requester belongs to this channel (`ac2:<did>[:<thid>]`) so we never post
    // another channel's sub-agent output — or warmup churn — into the wallet.
    if (!requesterSessionKey || !requesterSessionKey.startsWith(`${CHANNEL_ID}:`)) {
      log(
        'info',
        `[ac2] subagent_ended for run outside this channel (requester=${requesterSessionKey ?? '?'}); skipping delivery.`,
      );
      return;
    }
    const parentThid = resolveAc2SessionConversation(requesterSessionKey).threadId ?? DEFAULT_THID;
    let message = await resolveResult(childSessionKey, undefined);
    if (!message) message = completionMessage(undefined, kind, errorText);
    deliverCompletion(parentThid, message, kind);
    log('info', `[ac2] delivered untracked subagent completion into \`${parentThid}\` (${kind}).`);
  } catch (err) {
    log('warn', `[ac2] subagent_ended handler error: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Deliver a completion follow-up into a parent conversation thread. Emits a
 * thread-scoped `finalize` frame over the control (stream) transport and
 * persists it. Falls back to a raw transport write when no control channel was
 * negotiated. Background work is surfaced inline in the parent thread (no
 * dedicated `task-…` conversation).
 */
function deliverCompletion(parentThid: string, message: string, statusLabel: string): void {
  const active = sessionManager.getActive();
  if (!active) return;
  const control: Sendable | undefined =
    active.controlTransport && active.controlTransport.isOpen ? active.controlTransport : undefined;

  const messageId = `ac2-task-${Date.now()}`;
  if (control) {
    sendFinalize(control, parentThid, messageId, message);
  } else if (active.transport.isOpen) {
    // Stream-unaware wallet: a single plain-text write is the best we can do.
    try {
      active.transport.send(message);
    } catch {
      // best-effort
    }
  }

  if (active.requestId) {
    recordConversationMessage(active.requestId, parentThid, {
      role: 'agent',
      text: message,
      at: Date.now(),
    });
  }

  log('info', `[ac2] posted background-task completion into \`${parentThid}\` (${statusLabel}).`);
}

/**
 * Test/tuning seam for the background-task completion poller. The readers are
 * overridable so tests can inject a fake session store, and the timings can be
 * shrunk so a watcher resolves within a test tick.
 */
export const subagentPolling: {
  readStatus: typeof readChildSessionStatus;
  readResult: typeof readChildResultText;
  discover: typeof discoverChildSessionKey;
  intervalMs: number;
  maxWaitMs: number;
} = {
  readStatus: readChildSessionStatus,
  readResult: readChildResultText,
  discover: discoverChildSessionKey,
  intervalMs: 2000,
  maxWaitMs: 20 * 60 * 1000,
};

/**
 * Child session keys already claimed by *other* tracked tasks, so discovery for
 * one task never re-adopts a sibling task's child.
 */
function claimedChildKeys(exceptThid: string): Set<string> {
  const claimed = new Set<string>();
  for (const t of listTasks()) {
    if (t.taskThid === exceptThid) continue;
    if (t.childSessionKey) claimed.add(t.childSessionKey);
  }
  return claimed;
}

/**
 * Resolve the child session key for a task: use the captured one, else try to
 * discover it from the store by `spawnedBy === parentSessionKey`. Returns the
 * key (and records it on the task) or `undefined` if it can't be resolved yet.
 */
function resolveTaskChildKey(task: Ac2Task): string | undefined {
  if (task.childSessionKey) return task.childSessionKey;
  const discovered = subagentPolling.discover({
    ...(task.parentSessionKey !== undefined ? { parentSessionKey: task.parentSessionKey } : {}),
    ...(task.agentId !== undefined ? { agentId: task.agentId } : {}),
    excludeKeys: claimedChildKeys(task.taskThid),
  });
  if (discovered) {
    attachSpawnResult(task.taskThid, { childSessionKey: discovered });
    log(
      'info',
      `[ac2] discovered child session for background task \`${task.taskThid}\` via spawnedBy (${discovered}).`,
    );
  }
  return discovered;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Task thids with an in-flight completion watcher (dedupe re-entry). */
const watchedTasks = new Set<string>();

/**
 * Start polling a spawned background task's child session until it finishes,
 * then deliver its result into the parent conversation ourselves. This is the
 * PRIMARY completion path in the standalone pairing CLI.
 *
 * Why polling and not the `subagent_ended` hook: that hook only fires when the
 * host's *global* hook runner has been initialized, which happens during a full
 * gateway/server plugin-load boot. Our CLI hand-drives replies via
 * `dispatchReplyWithBufferedBlockDispatcher` and never runs that boot, so the
 * global runner stays null and `subagent_ended` is silently never dispatched to
 * us (`emitSubagentEndedHookOnce` early-returns). The host's own completion
 * "direct announce" also fails here because it needs a gateway request scope we
 * don't have (hence the repeated `… gateway request scope …` warnings). What
 * DOES happen regardless is that the host persists `status`/`endedAt` onto the
 * child's session entry when the run ends — so we observe completion by polling
 * that entry, then read the child's final assistant text from its transcript
 * and deliver it over our own DataChannel.
 *
 * Idempotent per `taskThid`; safe to call for the same task more than once.
 */
export function watchTaskCompletion(taskThid: string): void {
  if (watchedTasks.has(taskThid)) return;
  watchedTasks.add(taskThid);
  void pollTaskUntilComplete(taskThid).finally(() => watchedTasks.delete(taskThid));
}

/** Reset the in-flight watcher set (tests). */
export function resetTaskWatchers(): void {
  watchedTasks.clear();
}

async function pollTaskUntilComplete(taskThid: string): Promise<void> {
  const deadline = Date.now() + subagentPolling.maxWaitMs;
  const initial = getTaskByThid(taskThid);
  log(
    'info',
    `[ac2] watching background task \`${taskThid}\` for completion (child=${initial?.childSessionKey ?? 'unknown, will discover'}, parent=${initial?.parentSessionKey ?? '?'}).`,
  );
  // Emit the store diagnostic at most once, the first time we cannot resolve the
  // child session key, so a single failing run pinpoints any residual mismatch
  // (store path / agent id / owner casing) instead of polling silently.
  let diagLogged = false;
  try {
    while (Date.now() < deadline) {
      const task = getTaskByThid(taskThid);
      // Gone, or already reconciled by another path (e.g. the hook, if it ever
      // fires, or a direct delivery). Nothing left to do.
      if (!task || task.status !== 'running') return;
      // Resolve the child session key: captured at spawn, or discovered from the
      // store by `spawnedBy` when the accepted envelope never surfaced it.
      const childSessionKey = resolveTaskChildKey(task);
      if (childSessionKey) {
        const st = subagentPolling.readStatus({
          childSessionKey,
          ...(task.agentId !== undefined ? { agentId: task.agentId } : {}),
        });
        if (st.ended) {
          await finalizePolledTask({ ...task, childSessionKey }, st.status);
          return;
        }
      } else if (!diagLogged) {
        diagLogged = true;
        log(
          'warn',
          `[ac2] background task \`${taskThid}\` child session not resolved yet — ${describeSubagentCandidates(
            {
              ...(task.parentSessionKey !== undefined
                ? { parentSessionKey: task.parentSessionKey }
                : {}),
              ...(task.agentId !== undefined ? { agentId: task.agentId } : {}),
            },
          )}`,
        );
      }
      await delay(subagentPolling.intervalMs);
    }
    log(
      'info',
      `[ac2] background task \`${taskThid}\` still running after the watch window; stopped polling.`,
    );
  } catch (err) {
    log(
      'warn',
      `[ac2] background-task watcher error for \`${taskThid}\`: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function finalizePolledTask(task: Ac2Task, rawStatus?: string): Promise<void> {
  const kind: 'completed' | 'failed' | 'stopped' =
    rawStatus === 'failed' || rawStatus === 'timeout'
      ? 'failed'
      : rawStatus === 'killed'
        ? 'stopped'
        : 'completed';

  // On success deliver the child's actual answer (its final assistant text);
  // otherwise a plain lifecycle notice.
  let message = completionMessage(taskDisplayTitle(task), kind);
  if (kind === 'completed') {
    const text = await subagentPolling.readResult({
      ...(task.childSessionKey !== undefined ? { childSessionKey: task.childSessionKey } : {}),
      ...(task.agentId !== undefined ? { agentId: task.agentId } : {}),
    });
    if (text) message = text;
  }

  // Re-check: a concurrent path may have reconciled the task while we awaited
  // the transcript read.
  const fresh = getTaskByThid(task.taskThid);
  if (!fresh || fresh.status !== 'running') return;
  markTaskResult(task.taskThid, kind, message);
  // Flip the running task card in place to its terminal state with the child's
  // result inline (the self-contained task card, not a separate reply bubble).
  emitTaskCardUpdate({ thid: task.parentThid, task, status: kind, result: message });
  log(
    'info',
    `[ac2] delivered polled background-task card into \`${task.parentThid}\` (${kind}).`,
  );
}

/**
 * Register the sub-agent lifecycle hooks on the host plugin api (idempotent).
 *
 * These are typed *plugin hooks* — they must be registered via `api.on(hookName,
 * handler)` (the same surface Discord/Matrix use for `subagent_ended`), NOT via
 * `api.registerHook(...)`, which targets the unrelated internal command/session/
 * agent/gateway/message hook system and rejects these names ("hook registration
 * missing name"). The `api.on` handler is invoked with `(event, ctx)`, matching
 * our `handleSubagent*` signatures.
 */
let hooksRegistered = false;
export function registerSubagentHooks(api: OpenClawApi): void {
  if (hooksRegistered) return;
  if (typeof api.on !== 'function') {
    safeLog(api, 'warn', '[ac2] plugin api.on unavailable — subagent lifecycle hooks not registered.');
    return;
  }
  try {
    api.on(HOOK_SUBAGENT_SPAWNED, ((event: unknown, ctx: unknown) =>
      handleSubagentSpawned(event, ctx)) as never);
    api.on(HOOK_SUBAGENT_ENDED, ((event: unknown, ctx: unknown) =>
      handleSubagentEnded(event, ctx)) as never);
    hooksRegistered = true;
  } catch (err) {
    safeLog(api, 'error', `[ac2] api.on (subagent lifecycle) registration failed: ${err}`);
  }
}

/** Test hook: allow re-registration in isolated tests. */
export function resetSubagentHooksRegistration(): void {
  hooksRegistered = false;
}
