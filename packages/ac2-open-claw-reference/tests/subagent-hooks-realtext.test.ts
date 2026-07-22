import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';

// Mock the transcript reader so a completed run yields a known "real" answer,
// letting us assert the hook delivers the child's actual result (not the
// lifecycle notice) into the parent thread.
const mocks = vi.hoisted(() => ({
  readChildResultText: vi.fn(),
  readChildSessionStatus: vi.fn(() => ({ exists: false, ended: false })),
  discoverChildSessionKey: vi.fn(() => undefined),
  describeSubagentCandidates: vi.fn(() => 'diag'),
}));
vi.mock('../src/channel/subagent-result.js', () => ({
  readChildResultText: mocks.readChildResultText,
  readChildSessionStatus: mocks.readChildSessionStatus,
  discoverChildSessionKey: mocks.discoverChildSessionKey,
  describeSubagentCandidates: mocks.describeSubagentCandidates,
}));

import {
  registerTask,
  getTaskByThid,
  resetTasks,
  handleSubagentEnded,
  sessionManager,
} from '../src/index.js';

const CONTROLLER = 'did:key:zStubController';

interface Frame {
  t: string;
  thid?: string;
  text?: string;
  status?: string;
  result?: string;
}

describe('subagent_ended delivers the child result text', () => {
  const controlSent: string[] = [];

  beforeEach(() => {
    resetTasks();
    controlSent.length = 0;
    mocks.readChildResultText.mockReset();
    sessionManager.setActive({
      transport: { isOpen: true, send: () => {} } as unknown as Ac2Transport,
      client: {} as never,
      controllerDid: CONTROLLER,
      agentDid: 'did:ac2:agent',
      controlTransport: { isOpen: true, send: (p: string) => controlSent.push(p) },
    });
  });

  afterEach(() => {
    sessionManager.clearActive();
  });

  it('posts the real answer text into the parent thread on success', async () => {
    mocks.readChildResultText.mockResolvedValue('Here are the 3 findings you asked for.');
    const task = registerTask({
      parentThid: 'thread-7',
      task: 'do research',
      taskName: 'research',
      runId: 'run-1',
      childSessionKey: 'agent:main:subagent:abc',
    });

    await handleSubagentEnded(
      { targetSessionKey: 'agent:main:subagent:abc', outcome: 'ok', runId: 'run-1' },
      { runId: 'run-1', childSessionKey: 'agent:main:subagent:abc' },
    );

    const frame = JSON.parse(controlSent[0]!.slice(1)) as Frame;
    expect(frame.t).toBe('task');
    expect(frame.thid).toBe('thread-7');
    expect(frame.status).toBe('completed');
    expect(frame.result).toBe('Here are the 3 findings you asked for.');
    expect(getTaskByThid(task.taskThid)?.resultText).toBe(
      'Here are the 3 findings you asked for.',
    );
    // The reader is queried with the task's authoritative child identifiers.
    expect(mocks.readChildResultText).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionKey: 'agent:main:subagent:abc' }),
    );
  });

  it('does not query the transcript for a failed run', async () => {
    registerTask({
      parentThid: 'thread-7',
      task: 'flaky',
      taskName: 'flaky',
      runId: 'run-2',
      childSessionKey: 'agent:main:subagent:def',
    });

    await handleSubagentEnded(
      { targetSessionKey: 'agent:main:subagent:def', outcome: 'error', error: 'boom', runId: 'run-2' },
      { runId: 'run-2', childSessionKey: 'agent:main:subagent:def' },
    );

    const frame = JSON.parse(controlSent[0]!.slice(1)) as Frame;
    expect(frame.t).toBe('task');
    expect(frame.status).toBe('failed');
    expect(frame.result).toContain('failed');
    expect(mocks.readChildResultText).not.toHaveBeenCalled();
  });
});
