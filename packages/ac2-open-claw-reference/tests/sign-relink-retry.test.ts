import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';

import { signViaDaemon } from '../src/session/flows.js';

class FakeNotConnectedError extends Error {
  readonly code = 'not_connected';
}

function fakeClient(handler: () => Promise<unknown>) {
  return {
    request: handler,
    on: () => {},
    close: () => {},
    closed: Promise.resolve(),
  } as never;
}

const PARAMS = {
  description: 'test',
  payload_base64: Buffer.from('payload').toString('base64'),
};

const SIGNED_REPLY = {
  status: 'ok',
  message: {
    type: 'ac2/SigningResponse',
    thid: 'thread-1',
    body: {
      signature: Buffer.from(new Uint8Array(64).fill(1)).toString('base64'),
      public_key: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'),
    },
  },
};

describe('signViaDaemon relink retry', () => {
  it('rides through a transient not_connected blip and then succeeds', async () => {
    let calls = 0;
    const result = await signViaDaemon(
      PARAMS,
      { defaultTimeoutMs: 2_000 },
      {
        connect: async () =>
          fakeClient(async () => {
            calls += 1;
            if (calls < 3) throw new FakeNotConnectedError('no connected wallet');
            return SIGNED_REPLY;
          }),
      },
    );

    expect(calls).toBe(3);
    expect(result?.status).toBe('signed');
  });

  it('does not retry errors from after the request was relayed', async () => {
    let calls = 0;
    await expect(
      signViaDaemon(
        PARAMS,
        { defaultTimeoutMs: 2_000 },
        {
          connect: async () =>
            fakeClient(async () => {
              calls += 1;
              throw new Error('wallet timed out mid-approval');
            }),
        },
      ),
    ).rejects.toThrow('wallet timed out mid-approval');
    expect(calls).toBe(1);
  });

  it('still reports an unreachable daemon as null without retrying', async () => {
    let attempts = 0;
    const result = await signViaDaemon(
      PARAMS,
      { defaultTimeoutMs: 2_000 },
      {
        connect: async () => {
          attempts += 1;
          return undefined;
        },
      },
    );
    expect(result).toBeNull();
    expect(attempts).toBe(1);
  });
});
