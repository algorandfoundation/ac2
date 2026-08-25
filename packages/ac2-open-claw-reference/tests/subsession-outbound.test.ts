import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';
import { buildChannelObject, sessionManager } from '../src/index.js';

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

/**
 * The AC2 daemon's `openclaw-gateway` adapter now owns the whole per-turn
 * run/reply lifecycle; this plugin's `deliverAgentText` only handles
 * host-initiated (out-of-turn) sends pushed through the channel adapters
 * (e.g. `messaging.send.text`). These tests exercise that surviving delivery
 * route directly against `buildChannelObject()`.
 */
describe('host-initiated outbound (agent-driven delivery)', () => {
  const baseSent: string[] = [];
  const controlSent: string[] = [];

  beforeEach(() => {
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

  it('delivers a threaded reply as a finalize control frame over the dedicated stream channel', async () => {
    activate(true);

    const channel = buildChannelObject() as unknown as SendTextChannel;
    await channel.message.send.text({
      to: CONTROLLER,
      text: 'here is the research result',
      threadId: 'thread-7',
    });

    // A dedicated `ac2-stream` channel is preferred for host-initiated sends,
    // exactly like it is for the finalize path the daemon drives per-turn.
    expect(baseSent).toHaveLength(0);
    expect(controlSent).toHaveLength(1);
    expect(controlSent[0]!.startsWith(STX)).toBe(true);
    const frame = JSON.parse(controlSent[0]!.slice(1));
    expect(frame).toMatchObject({
      t: 'finalize',
      thid: 'thread-7',
      text: 'here is the research result',
    });
  });

  it('delivers a threaded reply as a raw transport write when no control channel exists', async () => {
    // Regression: with a single DataChannel (no dedicated `ac2-stream`), the
    // session has no `controlTransport` — the send must still reach the
    // wallet over the main transport rather than being silently dropped.
    activate(false);

    const channel = buildChannelObject() as unknown as SendTextChannel;
    await channel.message.send.text({
      to: CONTROLLER,
      text: 'here is the research result',
      threadId: 'thread-7',
    });

    expect(controlSent).toHaveLength(0);
    expect(baseSent).toEqual(['here is the research result']);
  });

  it('falls back to a raw transport write for untracked agent text when no control channel exists', async () => {
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
