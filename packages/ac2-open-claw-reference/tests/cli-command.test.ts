import { describe, expect, it } from 'vitest';

import { isMissingWebRtcError } from '../src/cli/ac2-command.js';

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
