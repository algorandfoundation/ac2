import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `pair` must never actually reach a daemon in this suite: mock
 * `connectAgentSession` (the very first daemon call `pair` makes, right after
 * committing the `AC2_RUNTIME` env var) to reject immediately, so these tests
 * observe the env-var side effect without spawning or dialing a real daemon.
 * Every other export of the control module is passed through untouched.
 */
vi.mock('@algorandfoundation/ac2-cli/control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@algorandfoundation/ac2-cli/control')>();
  return {
    ...actual,
    connectAgentSession: vi.fn(async () => {
      throw new Error('daemon unreachable (mocked for AC2_RUNTIME test)');
    }),
  };
});

import { buildAc2Command, isMissingWebRtcError } from '../src/cli/ac2-command.js';

/**
 * The daemon owns WebRTC now, so a missing `@roamhq/wrtc` arrives here as a
 * control-socket failure: `ControlRequestError` carries only the *message* the
 * daemon produced (the original `code` is dropped by the protocol). These
 * fixtures therefore mimic that shape — a plain `Error` subclass with a code
 * that is a protocol error code, never a NodeJS module-resolution code.
 */
class ControlRequestErrorLike extends Error {
  readonly code = 'internal_error';

  constructor(message: string) {
    super(message);
    this.name = 'ControlRequestError';
  }
}

describe('ac2 command WebRTC error handling', () => {
  it('matches missing @roamhq/wrtc package import failures relayed by the daemon', () => {
    expect(
      isMissingWebRtcError(
        new ControlRequestErrorLike(
          "Cannot find package '@roamhq/wrtc' imported from /usr/lib/node_modules/@algorandfoundation/ac2-cli/dist/providers.liquid-auth.js",
        ),
      ),
    ).toBe(true);
  });

  it('matches missing @roamhq/wrtc platform optional dependency failures', () => {
    expect(
      isMissingWebRtcError(new ControlRequestErrorLike("Cannot find module '@roamhq/wrtc-darwin-arm64'")),
    ).toBe(true);
  });

  it('matches @roamhq/wrtc binary search failures', () => {
    expect(
      isMissingWebRtcError(
        new ControlRequestErrorLike(
          'Could not find wrtc binary on any of the paths: ../build-darwin-arm64/wrtc.node,@roamhq/wrtc-darwin-arm64',
        ),
      ),
    ).toBe(true);
  });

  it('matches the same messages on a plain message-only Error', () => {
    // Nothing in the matcher may depend on the error subclass: the same text can
    // also reach us as a bare `Error` (e.g. a local throw or a re-wrapped cause).
    expect(isMissingWebRtcError(new Error("Cannot find package '@roamhq/wrtc'"))).toBe(true);
  });

  it('does not mask runtime errors from the WebRTC stack', () => {
    const err = new ControlRequestErrorLike('RTCDataChannel failed inside @roamhq/wrtc');
    err.stack = 'Error: RTCDataChannel failed\n    at node_modules/@roamhq/wrtc/lib/index.js';

    expect(isMissingWebRtcError(err)).toBe(false);
  });

  it('does not match unrelated module-load failures', () => {
    expect(isMissingWebRtcError(new ControlRequestErrorLike("Cannot find module 'socket.io-client'"))).toBe(
      false,
    );
  });

  it('does not match non-Error rejection values', () => {
    // `session.startPairing()` rejects with whatever the control client throws;
    // a string/undefined must never be treated as a WebRTC problem.
    expect(isMissingWebRtcError("Cannot find package '@roamhq/wrtc'")).toBe(false);
    expect(isMissingWebRtcError(undefined)).toBe(false);
  });
});

/**
 * `pair` commits new pairings to the daemon's `openclaw-gateway` runtime
 * adapter by setting `AC2_RUNTIME` (see `ac2-command.ts`) before it ever
 * dials the daemon. `connectAgentSession` is mocked to reject immediately
 * (above), so `pair` always fails fast right after that env-var commitment —
 * exactly the moment these tests need to observe.
 */
describe('ac2 pair command AC2_RUNTIME commitment', () => {
  const previousRuntime = process.env['AC2_RUNTIME'];

  afterEach(() => {
    if (previousRuntime === undefined) delete process.env['AC2_RUNTIME'];
    else process.env['AC2_RUNTIME'] = previousRuntime;
  });

  function fakeApi(): any {
    return {
      config: {},
      pluginConfig: {},
      logger: { info(): void {}, warn(): void {}, error(): void {} },
    };
  }

  it('sets AC2_RUNTIME to openclaw-gateway when the operator has not set it', async () => {
    delete process.env['AC2_RUNTIME'];
    const command = buildAc2Command(fakeApi()) as {
      handler: (ctx: { args?: string }) => Promise<{ text: string }>;
    };
    await command.handler({ args: 'pair' });
    expect(process.env['AC2_RUNTIME']).toBe('openclaw-gateway');
  });

  it('does not override an operator-provided AC2_RUNTIME value', async () => {
    process.env['AC2_RUNTIME'] = 'socket';
    const command = buildAc2Command(fakeApi()) as {
      handler: (ctx: { args?: string }) => Promise<{ text: string }>;
    };
    await command.handler({ args: 'pair' });
    expect(process.env['AC2_RUNTIME']).toBe('socket');
  });
});
