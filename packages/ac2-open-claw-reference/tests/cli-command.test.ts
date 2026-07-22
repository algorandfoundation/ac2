import { describe, expect, it } from 'vitest';

import { isMissingWebRtcError, shouldSeedConnectionId } from '../src/cli/ac2-command.js';

function moduleLoadError(code: 'ERR_MODULE_NOT_FOUND' | 'MODULE_NOT_FOUND', message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe('ac2 command WebRTC error handling', () => {
  it('matches missing @roamhq/wrtc package import failures', () => {
    expect(
      isMissingWebRtcError(
        moduleLoadError(
          'ERR_MODULE_NOT_FOUND',
          "Cannot find package '@roamhq/wrtc' imported from /plugin/dist/providers.liquid-auth.js",
        ),
      ),
    ).toBe(true);
  });

  it('matches missing @roamhq/wrtc platform optional dependency failures', () => {
    expect(
      isMissingWebRtcError(
        moduleLoadError(
          'MODULE_NOT_FOUND',
          "Cannot find module '@roamhq/wrtc-darwin-arm64'",
        ),
      ),
    ).toBe(true);
  });

  it('matches @roamhq/wrtc binary search failures', () => {
    expect(
      isMissingWebRtcError(
        new Error(
          'Could not find wrtc binary on any of the paths: ../build-darwin-arm64/wrtc.node,@roamhq/wrtc-darwin-arm64',
        ),
      ),
    ).toBe(true);
  });

  it('does not mask runtime errors from the WebRTC stack', () => {
    const err = new Error('RTCDataChannel failed inside @roamhq/wrtc');
    err.stack = 'Error: RTCDataChannel failed\n    at node_modules/@roamhq/wrtc/lib/index.js';

    expect(isMissingWebRtcError(err)).toBe(false);
  });

  it('does not match unrelated module-load failures', () => {
    expect(
      isMissingWebRtcError(moduleLoadError('MODULE_NOT_FOUND', "Cannot find module 'socket.io-client'")),
    ).toBe(false);
  });
});

describe('shouldSeedConnectionId', () => {
  it('seeds the stable connection id from the first pairing when none is persisted', () => {
    expect(shouldSeedConnectionId(undefined, 'req-fresh')).toBe(true);
    expect(shouldSeedConnectionId('', 'req-fresh')).toBe(true);
  });

  it('never re-seeds once a stable connection id already exists (reconnect keeps the id)', () => {
    // The whole point of the fix: a reconnect mints a *fresh* Liquid Auth
    // requestId, but the persisted connection id must stay put so history and
    // identity are not orphaned.
    expect(shouldSeedConnectionId('stable-connection-id', 'req-fresh')).toBe(false);
  });

  it('does not seed when the freshly-minted requestId is missing or blank', () => {
    expect(shouldSeedConnectionId(undefined, undefined)).toBe(false);
    expect(shouldSeedConnectionId(undefined, '')).toBe(false);
    expect(shouldSeedConnectionId(undefined, 42)).toBe(false);
  });
});
