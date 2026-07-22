import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';
import {
  buildChannelObject,
  sessionManager,
  registerTask,
  getTaskByThid,
  resetTasks,
} from '../src/index.js';

const STX = '\u0002';
const CONTROLLER = 'did:key:zStubController';

interface SendTextChannel {
  message: {
    send: {
      text: (a: {
        to: string;
        text: string;
        threadId?: string | number | null;
      }) => Promise<{ receipt: unknown }>;
    };
  };
}

describe('host-initiated outbound (sub-agent completion delivery)', () => {
  const baseSent: string[] = [];
  const controlSent: string[] = [];

  beforeEach(() => {
    resetTasks();
    baseSent.length = 0;
    controlSent.length = 0;
  });

  afterEach(() => {
    sessionManager.clearActive();
  });

  function activate(withControl: boolean): void {
    const transport = {
      isOpen: true,
      send: (payload: string) => baseSent.push(payload),
    } as unknown as Ac2Transport;
    sessionManager.setActive({
      transport,
      client: {} as never,
      controllerDid: CONTROLLER,
      agentDid: 'did:ac2:agent',
      ...(withControl
        ? {
            controlTransport: {
              isOpen: true,
              send: (payload: string) => controlSent.push(payload),
            },
          }
        : {}),
    });
  }

  it('emits a thread-scoped finalize frame and completes the matching task', async () => {
    activate(true);
    const task = registerTask({ parentThid: 'thread-7', task: 'do research', taskName: 'research' });

    const channel = buildChannelObject() as unknown as SendTextChannel;
    await channel.message.send.text({
      to: CONTROLLER,
      text: 'here is the research result',
      threadId: 'thread-7',
    });

    // The reply rides the ac2-stream control channel as a finalize frame keyed
    // to the originating thread — not a raw, thread-less transport write.
    expect(baseSent).toHaveLength(0);
    expect(controlSent).toHaveLength(1);
    const frame = JSON.parse(controlSent[0]!.slice(1));
    expect(controlSent[0]!.startsWith(STX)).toBe(true);
    expect(frame).toMatchObject({
      t: 'finalize',
      thid: 'thread-7',
      text: 'here is the research result',
    });
    expect(typeof frame.mid).toBe('string');

    // The completion announce flips the pending task to completed.
    expect(getTaskByThid(task.taskThid)?.status).toBe('completed');
    expect(getTaskByThid(task.taskThid)?.resultText).toBe('here is the research result');
  });

  it('falls back to a raw transport write when no control channel exists', async () => {
    activate(false);
    const channel = buildChannelObject() as unknown as SendTextChannel;
    await channel.message.send.text({ to: CONTROLLER, text: 'plain fallback' });
    expect(controlSent).toHaveLength(0);
    expect(baseSent).toEqual(['plain fallback']);
  });

  it('rejects delivery to a peer that is not the active controller', async () => {
    activate(true);
    const channel = buildChannelObject() as unknown as SendTextChannel;
    await expect(
      channel.message.send.text({ to: 'did:key:zSomeoneElse', text: 'nope' }),
    ).rejects.toThrow();
  });
});
