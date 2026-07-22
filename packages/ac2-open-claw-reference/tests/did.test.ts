import { describe, expect, it } from 'vitest';

import {
  extractEd25519PublicKey,
  normalizeDidKey,
  publicKeyToDidKey,
  resolveStableControllerDid,
} from '../src/identity/did.js';

// A genuine W3C did:key ed25519 example. We derive the public-key bytes from
// it (rather than hard-coding hex), which both validates the codec against a
// real-world canonical DID and keeps the vector self-consistent.
const CANONICAL_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

describe('did:key normalization', () => {
  const pub = extractEd25519PublicKey(CANONICAL_DID)!;

  it('decodes a 32-byte ed25519 public key from a real did:key', () => {
    expect(pub).toBeDefined();
    expect(pub.length).toBe(32);
  });

  it('encodes a raw ed25519 public key as the canonical did:key', () => {
    expect(publicKeyToDidKey(pub)).toBe(CANONICAL_DID);
  });

  it('normalizes a base64-encoded public key into the canonical did:key', () => {
    const did = normalizeDidKey(`did:key:${toBase64(pub)}`);
    expect(did).toBe(CANONICAL_DID);
  });

  it('normalizes a base64url-encoded public key into the canonical did:key', () => {
    const b64url = toBase64(pub).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(normalizeDidKey(`did:key:${b64url}`)).toBe(CANONICAL_DID);
  });

  it('is idempotent on an already-canonical did:key', () => {
    expect(normalizeDidKey(CANONICAL_DID)).toBe(CANONICAL_DID);
  });

  it('round-trips: re-encoding the extracted key yields the same did:key', () => {
    expect(publicKeyToDidKey(extractEd25519PublicKey(CANONICAL_DID)!)).toBe(CANONICAL_DID);
  });

  it('makes the same key in different encodings normalize equal', () => {
    const fromB64 = normalizeDidKey(`did:key:${toBase64(pub)}`);
    const fromCanonical = normalizeDidKey(CANONICAL_DID);
    expect(fromB64).toBe(fromCanonical);
  });

  it('leaves non-key placeholders untouched', () => {
    expect(normalizeDidKey('did:key:zAc2Controller')).toBe('did:key:zAc2Controller');
    expect(extractEd25519PublicKey('did:key:zAc2Controller')).toBeUndefined();
  });
});

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
