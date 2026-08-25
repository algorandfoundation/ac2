/// <reference types="vitest/globals" />

import {
  decode,
  isKeyRequest,
  isKeyResponse,
  isSigningRejected,
  isSigningRequest,
  isSigningResponse,
} from '../src/schema/decoder';

const NOW = Math.floor(Date.now() / 1000);

const baseEnvelope = {
  id: 'dec-001',
  from: 'did:key:alice',
  to: ['did:key:bob'],
  created_time: NOW,
};

const signingRequestMsg = {
  ...baseEnvelope,
  type: 'ac2/SigningRequest',
  body: {
    description: 'Sign Algorand transaction',
    encoding: 'base64',
    payload: 'dGVzdA==',
  },
};

// ─── decode() ─────────────────────────────────────────────────────────────────

describe('decode()', () => {
  it('decodes a valid JSON string', () => {
    const { message, validation } = decode(JSON.stringify(signingRequestMsg));
    expect(validation.valid).toBe(true);
    expect(message.type).toBe('ac2/SigningRequest');
  });

  it('decodes a plain object without cloning it', () => {
    const { message, validation } = decode(signingRequestMsg);
    expect(validation.valid).toBe(true);
    expect(message.id).toBe('dec-001');
  });

  it('returns invalid for malformed JSON', () => {
    const { validation } = decode('{bad json}');
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toMatch(/Invalid JSON/);
  });

  it('returns invalid for a structurally wrong object', () => {
    const { validation } = decode({ type: 'ac2/SigningRequest' });
    expect(validation.valid).toBe(false);
  });

  it('sets messageType on the validation result', () => {
    const { validation } = decode(signingRequestMsg);
    expect(validation.messageType).toBe('ac2/SigningRequest');
  });
});

// ─── Type guards ──────────────────────────────────────────────────────────────

describe('type guards', () => {
  it('isSigningRequest: true for matching type', () => {
    const { message } = decode(signingRequestMsg);
    expect(isSigningRequest(message)).toBe(true);
  });

  it('isSigningRequest: false for other types', () => {
    const { message } = decode({
      ...baseEnvelope,
      type: 'ac2/SigningResponse',
      body: { signature: 'sig' },
    });
    expect(isSigningRequest(message)).toBe(false);
  });

  it('isSigningResponse', () => {
    const { message } = decode({
      ...baseEnvelope,
      type: 'ac2/SigningResponse',
      body: { signature: 'sig' },
    });
    expect(isSigningResponse(message)).toBe(true);
  });

  it('isKeyRequest', () => {
    const { message } = decode({
      ...baseEnvelope,
      type: 'ac2/KeyRequest',
      body: { key_type: 'ed25519', purpose: 'test', for_operation: 'test' },
    });
    expect(isKeyRequest(message)).toBe(true);
  });

  it('isKeyResponse', () => {
    const { message } = decode({
      ...baseEnvelope,
      type: 'ac2/KeyResponse',
      body: { key_type: 'ed25519', public_key: 'abc', encoding: 'base64' },
    });
    expect(isKeyResponse(message)).toBe(true);
  });

  it('isSigningRejected', () => {
    const { message } = decode({
      ...baseEnvelope,
      type: 'ac2/SigningRejected',
      body: { reason: 'Not approved' },
    });
    expect(isSigningRejected(message)).toBe(true);
  });
});
