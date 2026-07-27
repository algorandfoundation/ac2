import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';
import {
  registerTask,
  getTaskByThid,
  findTaskByRun,
  markTaskResult,
  resetTasks,
  handleSubagentSpawned,
  handleSubagentEnded,
  registerSubagentHooks,
  resetSubagentHooksRegistration,
  watchTaskCompletion,
  resetTaskWatchers,
  subagentPolling,
  sessionManager,
} from '../src/index.js';

/** Snapshot of the default poller wiring, restored after each poller test. */
const DEFAULT_POLLING = { ...subagentPolling };
/** Flush the microtask/timer queue so a fire-and-forget watcher can settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const STX = '\u0002';
const CONTROLLER = 'did:key:zStubController';

interface Frame {
  t: string;
  thid?: string;
  mid?: string;
  text?: string;
  id?: string;
  title?: string;
  status?: string;
  prompt?: string;
  result?: string;
}

describe('sub-agent lifecycle hooks (background-task completion)', () => {
  const controlSent: string[] = [];
  const baseSent: string[] = [];

  function frames(): Frame[] {
    return controlSent.map((raw) => JSON.parse(raw.slice(1)) as Frame);
  }

  beforeEach(() => {
    resetTasks();
    resetSubagentHooksRegistration();
    resetTaskWatchers();
    Object.assign(subagentPolling, DEFAULT_POLLING);
    controlSent.length = 0;
    baseSent.length = 0;
    // Activate WITHOUT a requestId so we exercise the wire (control frames) and
    // task lifecycle without touching on-disk persistence.
    const transport = {
      isOpen: true,
      send: (payload: string) => baseSent.push(payload),
    } as unknown as Ac2Transport;
    sessionManager.setActive({
      transport,
      client: {} as never,
      controllerDid: CONTROLLER,
      agentDid: 'did:ac2:agent',
      controlTransport: {
        isOpen: true,
        send: (payload: string) => controlSent.push(payload),
      },
    });
  });

  afterEach(() => {
    sessionManager.clearActive();
  });

  it('posts a completion message into the parent thread on success', async () => {
    const task = registerTask({
      parentThid: 'thread-7',
      task: 'do research',
      taskName: 'research',
      runId: 'run-1',
      childSessionKey: 'child-1',
    });

    await handleSubagentEnded(
      { targetSessionKey: 'child-1', outcome: 'ok', runId: 'run-1' },
      { runId: 'run-1', childSessionKey: 'child-1' },
    );

    const f = frames();
    // A single self-contained task card into the parent thread (no dedicated
    // task-… thread). The child's transcript is unavailable in this test, so we
    // fall back to the lifecycle notice as the card's result text.
    expect(f).toHaveLength(1);
    expect(f[0]!.t).toBe('task');
    expect(f[0]!.thid).toBe('thread-7');
    expect(f[0]!.status).toBe('completed');
    expect(f[0]!.result).toContain('finished');
    expect(f[0]!.result).toContain('research');
    expect(controlSent[0]!.startsWith(STX)).toBe(true);

    // The task is flipped to completed with the notice as its result text.
    expect(getTaskByThid(task.taskThid)?.status).toBe('completed');
  });

  it('reports a failure (with error text) and marks the task failed', async () => {
    const task = registerTask({
      parentThid: 'thread-7',
      task: 'flaky job',
      taskName: 'flaky',
      runId: 'run-2',
      childSessionKey: 'child-2',
    });

    await handleSubagentEnded(
      { targetSessionKey: 'child-2', outcome: 'error', error: 'boom', runId: 'run-2' },
      { runId: 'run-2', childSessionKey: 'child-2' },
    );

    const f = frames();
    expect(f).toHaveLength(1);
    expect(f[0]!.t).toBe('task');
    expect(f[0]!.thid).toBe('thread-7');
    expect(f[0]!.status).toBe('failed');
    expect(f[0]!.result).toContain('failed');
    expect(f[0]!.result).toContain('boom');
    expect(getTaskByThid(task.taskThid)?.status).toBe('failed');
  });

  it('reports a killed run as stopped', async () => {
    const task = registerTask({
      parentThid: 'thread-7',
      task: 'long job',
      taskName: 'long',
      runId: 'run-3',
      childSessionKey: 'child-3',
    });

    await handleSubagentEnded(
      { targetSessionKey: 'child-3', reason: 'killed', runId: 'run-3' },
      { runId: 'run-3', childSessionKey: 'child-3' },
    );

    const f = frames();
    expect(f[0]!.t).toBe('task');
    expect(f[0]!.status).toBe('stopped');
    expect(f[0]!.result).toContain('stopped');
    expect(getTaskByThid(task.taskThid)?.status).toBe('stopped');
  });

  it('ignores internal reset/deleted lifecycle churn', async () => {
    const task = registerTask({
      parentThid: 'thread-7',
      task: 'noop',
      taskName: 'noop',
      runId: 'run-4',
      childSessionKey: 'child-4',
    });

    await handleSubagentEnded(
      { targetSessionKey: 'child-4', reason: 'reset', runId: 'run-4' },
      { runId: 'run-4', childSessionKey: 'child-4' },
    );

    expect(controlSent).toHaveLength(0);
    expect(getTaskByThid(task.taskThid)?.status).toBe('running');
  });

  it('does not double-post when the task was already reconciled', async () => {
    const task = registerTask({
      parentThid: 'thread-7',
      task: 'done already',
      taskName: 'dupe',
      runId: 'run-5',
      childSessionKey: 'child-5',
    });
    // Simulate deliverAgentText having already completed it.
    await handleSubagentEnded(
      { targetSessionKey: 'child-5', outcome: 'ok', runId: 'run-5' },
      { runId: 'run-5', childSessionKey: 'child-5' },
    );
    controlSent.length = 0;
    // A second (duplicate) end event must be a no-op.
    await handleSubagentEnded(
      { targetSessionKey: 'child-5', outcome: 'ok', runId: 'run-5' },
      { runId: 'run-5', childSessionKey: 'child-5' },
    );
    expect(controlSent).toHaveLength(0);
    expect(getTaskByThid(task.taskThid)?.status).toBe('completed');
  });

  it('binds the authoritative runId/childSessionKey on spawn correlation', () => {
    // Routing registered the task from the tool call, but without ids yet.
    registerTask({ parentThid: 'thread-7', task: 'pending job', taskName: 'pending' });

    handleSubagentSpawned(
      { requester: { threadId: 'thread-7' }, agentId: 'agent-x', label: 'pending' },
      { runId: 'run-9', childSessionKey: 'child-9' },
    );

    const bound = findTaskByRun({ runId: 'run-9' });
    expect(bound?.taskThid).toBe('task-pending');
    expect(bound?.childSessionKey).toBe('child-9');
    expect(bound?.agentId).toBe('agent-x');
  });

  it('falls back to a raw transport write when no control channel exists', async () => {
    sessionManager.clearActive();
    const transport = {
      isOpen: true,
      send: (payload: string) => baseSent.push(payload),
    } as unknown as Ac2Transport;
    sessionManager.setActive({
      transport,
      client: {} as never,
      controllerDid: CONTROLLER,
      agentDid: 'did:ac2:agent',
    });
    registerTask({
      parentThid: 'thread-7',
      task: 'plain',
      taskName: 'plain',
      runId: 'run-6',
      childSessionKey: 'child-6',
    });

    await handleSubagentEnded(
      { targetSessionKey: 'child-6', outcome: 'ok', runId: 'run-6' },
      { runId: 'run-6', childSessionKey: 'child-6' },
    );

    expect(controlSent).toHaveLength(0);
    expect(baseSent).toHaveLength(1);
    expect(baseSent[0]).toContain('finished');
  });

  it('delivers an untracked completion to the thread from the requester key', async () => {
    // No registerTask(): simulate the spawn tool-result/spawned-hook binding
    // being missed, so findTaskByRun returns nothing. The completion must still
    // be delivered, routed via the requester session key's thread.
    await handleSubagentEnded(
      { targetSessionKey: 'agent:main:subagent:abc', outcome: 'ok', runId: 'run-untracked' },
      {
        runId: 'run-untracked',
        childSessionKey: 'agent:main:subagent:abc',
        requesterSessionKey: `ac2:${CONTROLLER}:thread-42`,
      },
    );

    const f = frames();
    expect(f).toHaveLength(1);
    expect(f[0]!.t).toBe('finalize');
    expect(f[0]!.thid).toBe('thread-42');
    // Transcript is unavailable in this test → lifecycle notice fallback.
    expect(f[0]!.text).toContain('finished');
  });

  it('routes an untracked default-thread completion to the default thread', async () => {
    await handleSubagentEnded(
      { targetSessionKey: 'agent:main:subagent:def', outcome: 'ok', runId: 'run-default' },
      {
        runId: 'run-default',
        childSessionKey: 'agent:main:subagent:def',
        requesterSessionKey: `ac2:${CONTROLLER}:default`,
      },
    );

    const f = frames();
    expect(f).toHaveLength(1);
    expect(f[0]!.thid).toBe('default');
    expect(f[0]!.text).toContain('finished');
  });

  it('skips untracked completions whose requester is not this channel', async () => {
    await handleSubagentEnded(
      { targetSessionKey: 'agent:main:subagent:ghi', outcome: 'ok', runId: 'run-foreign' },
      {
        runId: 'run-foreign',
        childSessionKey: 'agent:main:subagent:ghi',
        requesterSessionKey: 'discord:guild:123:channel:456',
      },
    );

    expect(controlSent).toHaveLength(0);
    expect(baseSent).toHaveLength(0);
  });

  it('polls a spawned task to completion and delivers the child result', async () => {
    const task = registerTask({
      parentThid: 'thread-9',
      task: 'crunch numbers',
      taskName: 'crunch',
      runId: 'run-poll-1',
      childSessionKey: 'agent:main:subagent:poll1',
    });

    subagentPolling.intervalMs = 1;
    subagentPolling.readStatus = () => ({ exists: true, ended: true, status: 'done' });
    subagentPolling.readResult = async () => 'The answer is 42.';

    watchTaskCompletion(task.taskThid);
    await flush();

    const f = frames();
    expect(f).toHaveLength(1);
    expect(f[0]!.t).toBe('task');
    expect(f[0]!.thid).toBe('thread-9');
    expect(f[0]!.status).toBe('completed');
    expect(f[0]!.result).toBe('The answer is 42.');
    expect(getTaskByThid(task.taskThid)?.status).toBe('completed');
  });

  it('discovers the child session by spawnedBy when the spawn key was not captured', async () => {
    const task = registerTask({
      parentThid: 'thread-disc',
      parentSessionKey: 'ac2:did:key:zStubController:thread-disc',
      task: 'no key captured',
      taskName: 'discover',
      runId: 'run-disc',
      // NOTE: no childSessionKey — the accepted-spawn envelope never surfaced it.
    });

    let discoverArgs: unknown;
    subagentPolling.intervalMs = 1;
    subagentPolling.discover = (opts) => {
      discoverArgs = opts;
      return 'agent:main:subagent:discovered';
    };
    subagentPolling.readStatus = () => ({ exists: true, ended: true, status: 'done' });
    subagentPolling.readResult = async () => 'recovered answer';

    watchTaskCompletion(task.taskThid);
    await flush();

    expect(discoverArgs).toMatchObject({
      parentSessionKey: 'ac2:did:key:zStubController:thread-disc',
    });
    const f = frames();
    expect(f).toHaveLength(1);
    expect(f[0]!.t).toBe('task');
    expect(f[0]!.thid).toBe('thread-disc');
    expect(f[0]!.result).toBe('recovered answer');
    // The discovered key is recorded on the task for later correlation.
    expect(getTaskByThid(task.taskThid)?.childSessionKey).toBe('agent:main:subagent:discovered');
    expect(getTaskByThid(task.taskThid)?.status).toBe('completed');
  });

  it('keeps polling while the child runs, then delivers once it ends', async () => {
    const task = registerTask({
      parentThid: 'thread-10',
      task: 'long job',
      taskName: 'poll2',
      runId: 'run-poll-2',
      childSessionKey: 'agent:main:subagent:poll2',
    });

    let calls = 0;
    subagentPolling.intervalMs = 1;
    subagentPolling.readStatus = () => {
      calls += 1;
      return calls < 3
        ? { exists: true, ended: false, status: 'running' }
        : { exists: true, ended: true, status: 'done' };
    };
    subagentPolling.readResult = async () => 'done result';

    watchTaskCompletion(task.taskThid);
    await flush();

    expect(calls).toBeGreaterThanOrEqual(3);
    const f = frames();
    expect(f).toHaveLength(1);
    expect(f[0]!.result).toBe('done result');
    expect(getTaskByThid(task.taskThid)?.status).toBe('completed');
  });

  it('delivers a lifecycle notice (not result text) for a failed run', async () => {
    const task = registerTask({
      parentThid: 'thread-11',
      task: 'flaky job',
      taskName: 'poll3',
      runId: 'run-poll-3',
      childSessionKey: 'agent:main:subagent:poll3',
    });

    subagentPolling.intervalMs = 1;
    subagentPolling.readStatus = () => ({ exists: true, ended: true, status: 'failed' });
    subagentPolling.readResult = async () => 'should not be read for a failure';

    watchTaskCompletion(task.taskThid);
    await flush();

    const f = frames();
    expect(f).toHaveLength(1);
    expect(f[0]!.status).toBe('failed');
    expect(f[0]!.result).toContain('failed');
    expect(getTaskByThid(task.taskThid)?.status).toBe('failed');
  });

  it('does nothing when the task was already reconciled', async () => {
    const task = registerTask({
      parentThid: 'thread-12',
      task: 'already done',
      taskName: 'poll4',
      childSessionKey: 'agent:main:subagent:poll4',
    });
    markTaskResult(task.taskThid, 'completed', 'already delivered');

    subagentPolling.intervalMs = 1;
    subagentPolling.readStatus = () => ({ exists: true, ended: true, status: 'done' });
    subagentPolling.readResult = async () => 'unexpected';

    watchTaskCompletion(task.taskThid);
    await flush();

    expect(controlSent).toHaveLength(0);
    expect(baseSent).toHaveLength(0);
  });

  it('registers both lifecycle hooks on the plugin api via api.on', () => {
    const registered: string[] = [];
    const api = {
      on: (hookName: string) => {
        registered.push(hookName);
      },
    } as unknown as Parameters<typeof registerSubagentHooks>[0];

    registerSubagentHooks(api);
    expect(registered).toContain('subagent_spawned');
    expect(registered).toContain('subagent_ended');
  });
});
