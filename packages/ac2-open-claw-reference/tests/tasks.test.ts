import { describe, it, expect, beforeEach } from 'vitest';
import {
  deriveTaskThid,
  isTaskThid,
  registerTask,
  attachSpawnResult,
  taskDisplayTitle,
  findTaskByRun,
  findPendingTaskForParent,
  markTaskResult,
  getTaskByThid,
  listTasks,
  resetTasks,
  TASK_THREAD_PREFIX,
} from '../src/index.js';

describe('sub-agent task registry', () => {
  beforeEach(() => {
    resetTasks();
  });

  describe('deriveTaskThid', () => {
    it('prefers taskName, then label, then a short runId', () => {
      expect(deriveTaskThid({ taskName: 'Docs_Update' })).toBe(`${TASK_THREAD_PREFIX}docs-update`);
      expect(deriveTaskThid({ label: 'Linux Validation' })).toBe(
        `${TASK_THREAD_PREFIX}linux-validation`,
      );
      expect(deriveTaskThid({ runId: 'run-abcdef0123456789' })).toBe(
        `${TASK_THREAD_PREFIX}run-abcdef01`,
      );
    });

    it('falls back to a unique anonymous id when nothing is provided', () => {
      const a = deriveTaskThid({});
      const b = deriveTaskThid({});
      expect(a).not.toBe(b);
      expect(isTaskThid(a)).toBe(true);
      expect(isTaskThid(b)).toBe(true);
    });
  });

  it('registers a running task under a stable thread id and derives a title', () => {
    const task = registerTask({
      parentThid: 'default',
      task: 'Research the weather API',
      taskName: 'weather_research',
      label: 'Weather research',
    });
    expect(task.taskThid).toBe(`${TASK_THREAD_PREFIX}weather-research`);
    expect(task.status).toBe('running');
    expect(task.parentThid).toBe('default');
    expect(taskDisplayTitle(task)).toBe('Weather research');
    expect(getTaskByThid(task.taskThid)).toEqual(task);
  });

  it('enriches an existing task in place with the accepted spawn envelope', () => {
    const task = registerTask({
      parentThid: 'default',
      task: 'do work',
      taskName: 'worker',
    });
    const enriched = attachSpawnResult(task.taskThid, {
      runId: 'run-xyz',
      childSessionKey: 'agent:a:subagent:uuid',
    });
    expect(enriched?.runId).toBe('run-xyz');
    expect(enriched?.childSessionKey).toBe('agent:a:subagent:uuid');
    // No duplicate task was created.
    expect(listTasks()).toHaveLength(1);
    expect(findTaskByRun({ runId: 'run-xyz' })?.taskThid).toBe(task.taskThid);
    expect(findTaskByRun({ childSessionKey: 'agent:a:subagent:uuid' })?.taskThid).toBe(
      task.taskThid,
    );
  });

  it('finds the newest pending task for a parent and clears it once completed', () => {
    const first = registerTask({ parentThid: 'thread-1', task: 'a', taskName: 'a' });
    const second = registerTask({ parentThid: 'thread-1', task: 'b', taskName: 'b' });
    // A task on another parent must not be returned.
    registerTask({ parentThid: 'thread-2', task: 'c', taskName: 'c' });

    expect(findPendingTaskForParent('thread-1')?.taskThid).toBe(second.taskThid);

    markTaskResult(second.taskThid, 'completed', 'done b');
    expect(getTaskByThid(second.taskThid)?.status).toBe('completed');
    expect(getTaskByThid(second.taskThid)?.resultText).toBe('done b');
    // Now the older still-running task is the pending one.
    expect(findPendingTaskForParent('thread-1')?.taskThid).toBe(first.taskThid);
  });

  it('records a failed terminal status', () => {
    const task = registerTask({ parentThid: 'default', task: 'x', taskName: 'x' });
    markTaskResult(task.taskThid, 'failed', 'boom');
    expect(getTaskByThid(task.taskThid)?.status).toBe('failed');
    expect(findPendingTaskForParent('default')).toBeUndefined();
  });
});
