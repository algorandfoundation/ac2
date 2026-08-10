import { describe, expect, it } from 'vitest';

import { resolveStableControllerDid } from '../src/identity/index.js';

// The same canonical DID used by the SDK's `did:key` normalization tests
// (`packages/ac2-sdk/tests/did.test.ts`), which now own the normalization
// unit tests since `extractEd25519PublicKey`/`normalizeDidKey`/
// `publicKeyToDidKey` moved to `@algorandfoundation/ac2-sdk/signaling`. This
// module only re-exports them (see `../src/identity/did.js`) and keeps its
// own `resolveStableControllerDid`, which is CLI/session-specific.
const CANONICAL_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

/**
 * The agent's OpenClaw session is keyed by `ac2:<controllerDid>:<thid>`, and
 * that transcript is persisted on disk — so a reconnect only restores the
 * thread's context when `controllerDid` resolves to the same value every time.
 * `resolveStableControllerDid` anchors it to the granted identity so a
 * presence-only reconnect (which may omit the wallet / carry a differently
 * encoded peer DID) can never rotate the key and "forget" the conversation.
 */
describe('resolveStableControllerDid — reconnect session-key stability', () => {
  const GRANTED = CANONICAL_DID;

  it('anchors to the granted identity even when the live link omits the account', () => {
    expect(
      resolveStableControllerDid({ storedControllerDid: GRANTED, connectedAccountDid: undefined }),
    ).toBe(GRANTED);
  });

  it('keeps the granted identity even if the live link reports a different account', () => {
    // A presence-only reconnect must not rebind the routing key to a new DID.
    expect(
      resolveStableControllerDid({
        storedControllerDid: GRANTED,
        connectedAccountDid: 'did:key:zSomeOtherAccount',
      }),
    ).toBe(GRANTED);
  });

  it('falls back to the live account before any identity is granted', () => {
    expect(
      resolveStableControllerDid({
        storedControllerDid: undefined,
        connectedAccountDid: GRANTED,
      }),
    ).toBe(GRANTED);
  });

  it('falls back to an explicit placeholder when nothing is known', () => {
    expect(
      resolveStableControllerDid({
        storedControllerDid: undefined,
        connectedAccountDid: undefined,
        placeholder: 'did:key:zPlaceholder',
      }),
    ).toBe('did:key:zPlaceholder');
  });

  it('uses the default placeholder when none is provided', () => {
    expect(resolveStableControllerDid({})).toBe('did:key:zAc2Controller');
  });
});
