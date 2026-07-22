/**
 * Sub-agent ("background task") registry.
 *
 * The OpenClaw host runs each `sessions_spawn` child in its own isolated
 * session (`agent:<agentId>:subagent:<uuid>`) on the `subagent` lane and, when
 * the child finishes, delivers its result back to the requester session as a
 * *separate* host-initiated turn — never inline through the spawning turn's
 * reply stream. To surface that work in the wallet we mirror each child as a
 * first-class "task": it gets a dedicated `task-<name>` conversation thread and
 * a lifecycle (`running` → `completed`/`failed`) that the parent chat can card.
 *
 * This registry is intentionally in-memory and process-scoped (like
 * `activeThreadByConnection` in `conversation.ts`): a single wallet owns a
 * single DataChannel, so a module-level map is sufficient. Durable task history
 * still flows through the normal per-thread persistence in `identity/state.ts`.
 */

/** Prefix for every synthetic background-task thread id. */
export const TASK_THREAD_PREFIX = 'task-';

/** Lifecycle of a tracked background task. */
export type Ac2TaskStatus = 'running' | 'completed' | 'failed';

/** A single tracked sub-agent run. */
export interface Ac2Task {
  /** Synthetic wallet thread id for this task (`task-<name|run>`), the map key. */
  taskThid: string;
  /** The parent conversation `thid` the `sessions_spawn` tool call ran in. */
  parentThid: string;
  /** The delegated task prompt (`sessions_spawn` `task` arg). */
  task: string;
  /** Host run id from the accepted spawn envelope, once known. */
  runId?: string;
  /** Host child session key from the accepted spawn envelope, once known. */
  childSessionKey?: string;
  /** Model-facing stable handle (`sessions_spawn` `taskName` arg). */
  taskName?: string;
  /** Human-readable label (`sessions_spawn` `label` arg). */
  label?: string;
  /** Target agent id when the child runs under another configured agent. */
  agentId?: string;
  /** Current lifecycle status. */
  status: Ac2TaskStatus;
  /** Latest visible result/announce text from the child, once delivered. */
  resultText?: string;
  createdAt: number;
  updatedAt: number;
}

const tasksByThid = new Map<string, Ac2Task>();

/** Sanitize a candidate label into a thread-id-safe slug. */
function slug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Derive a stable, human-friendly task thread id from the available handles.
 * Prefers an explicit `taskName`, then a `label`, then a short `runId`, and
 * finally a monotonic fallback so two anonymous spawns never collide.
 */
let anonSeq = 0;
export function deriveTaskThid(opts: {
  taskName?: string;
  label?: string;
  runId?: string;
}): string {
  const fromName = opts.taskName ? slug(opts.taskName) : '';
  if (fromName) return `${TASK_THREAD_PREFIX}${fromName}`;
  const fromLabel = opts.label ? slug(opts.label) : '';
  if (fromLabel) return `${TASK_THREAD_PREFIX}${fromLabel}`;
  const fromRun = opts.runId ? slug(opts.runId).slice(0, 12) : '';
  if (fromRun) return `${TASK_THREAD_PREFIX}${fromRun}`;
  anonSeq += 1;
  return `${TASK_THREAD_PREFIX}${anonSeq}`;
}

/** True for any thread id this registry owns (a `task-…` thread). */
export function isTaskThid(thid: string): boolean {
  return thid.startsWith(TASK_THREAD_PREFIX);
}

/**
 * Register (or update) a task from a `sessions_spawn` observation. Idempotent
 * on `taskThid`: a later call carrying the accepted `runId`/`childSessionKey`
 * enriches the existing record instead of creating a duplicate.
 */
export function registerTask(input: {
  parentThid: string;
  task: string;
  taskName?: string;
  label?: string;
  agentId?: string;
  runId?: string;
  childSessionKey?: string;
}): Ac2Task {
  const taskThid = deriveTaskThid({
    ...(input.taskName !== undefined ? { taskName: input.taskName } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
  });
  const now = Date.now();
  const existing = tasksByThid.get(taskThid);
  const task: Ac2Task = existing
    ? {
        ...existing,
        updatedAt: now,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.childSessionKey !== undefined
          ? { childSessionKey: input.childSessionKey }
          : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      }
    : {
        taskThid,
        parentThid: input.parentThid,
        task: input.task,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        ...(input.taskName !== undefined ? { taskName: input.taskName } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.childSessionKey !== undefined
          ? { childSessionKey: input.childSessionKey }
          : {}),
      };
  tasksByThid.set(taskThid, task);
  return task;
}

/** Enrich an existing task in place with the accepted spawn envelope. */
export function attachSpawnResult(
  taskThid: string,
  patch: { runId?: string; childSessionKey?: string; agentId?: string },
): Ac2Task | undefined {
  const existing = tasksByThid.get(taskThid);
  if (!existing) return undefined;
  const updated: Ac2Task = {
    ...existing,
    updatedAt: Date.now(),
    ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
    ...(patch.childSessionKey !== undefined ? { childSessionKey: patch.childSessionKey } : {}),
    ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
  };
  tasksByThid.set(taskThid, updated);
  return updated;
}

/** A short, human-facing title for a task (label → name → derived id). */
export function taskDisplayTitle(task: Ac2Task): string {
  return (
    task.label ??
    task.taskName ??
    `Task ${task.taskThid.slice(TASK_THREAD_PREFIX.length)}`
  );
}

/** Look up a task by its synthetic thread id. */
export function getTaskByThid(taskThid: string): Ac2Task | undefined {
  return tasksByThid.get(taskThid);
}

/** Look up a task by host run id or child session key (announce correlation). */
export function findTaskByRun(opts: {
  runId?: string;
  childSessionKey?: string;
}): Ac2Task | undefined {
  for (const task of tasksByThid.values()) {
    if (opts.runId && task.runId === opts.runId) return task;
    if (opts.childSessionKey && task.childSessionKey === opts.childSessionKey) return task;
  }
  return undefined;
}

/**
 * Best-effort correlation for a completion announce that only tells us the
 * parent thread it is being delivered into: return the most recently updated
 * still-`running` task spawned from that parent.
 */
export function findPendingTaskForParent(parentThid: string): Ac2Task | undefined {
  let best: Ac2Task | undefined;
  for (const task of tasksByThid.values()) {
    if (task.parentThid !== parentThid || task.status !== 'running') continue;
    if (!best || task.updatedAt >= best.updatedAt) best = task;
  }
  return best;
}

/** Record a terminal result on a task. */
export function markTaskResult(
  taskThid: string,
  status: Exclude<Ac2TaskStatus, 'running'>,
  resultText?: string,
): Ac2Task | undefined {
  const existing = tasksByThid.get(taskThid);
  if (!existing) return undefined;
  const updated: Ac2Task = {
    ...existing,
    status,
    updatedAt: Date.now(),
    ...(resultText !== undefined ? { resultText } : {}),
  };
  tasksByThid.set(taskThid, updated);
  return updated;
}

/** All tracked tasks, most-recently-updated first. */
export function listTasks(): Ac2Task[] {
  return Array.from(tasksByThid.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Test/reset hook: drop all tracked tasks. */
export function resetTasks(): void {
  tasksByThid.clear();
  anonSeq = 0;
}
