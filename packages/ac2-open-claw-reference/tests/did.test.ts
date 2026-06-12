import { describe, expect, it } from 'vitest';

import {
  extractEd25519PublicKey,
  normalizeDidKey,
  publicKeyToDidKey,
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
