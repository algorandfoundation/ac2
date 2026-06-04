/// <reference types="vitest/globals" />

import { AC2MessageTypes } from '../src/schema/types';
import { validate, validateBody } from '../src/schema/validator';

const NOW = Math.floor(Date.now() / 1000);

const validSigningRequest = {
  id: 'test-001',
  type: 'ac2/SigningRequest',
  from: 'did:key:alice',
  to: ['did:key:bob'],
  created_time: NOW,
  body: {
    description: 'Sign this payload',
    encoding: 'base64',
    payload: 'dGVzdA==',
  },
};

// ─── Base envelope ────────────────────────────────────────────────────────────

describe('validate() — base envelope', () => {
  it('accepts a fully valid SigningRequest', () => {
    const r = validate(validSigningRequest);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects a non-object payload', () => {
    const r = validate('not-an-object');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/non-null object/);
  });

  it('rejects null', () => {
    const r = validate(null);
    expect(r.valid).toBe(false);
  });

  it('rejects missing id', () => {
    const { id: _, ...noId } = validSigningRequest;
    const r = validate(noId);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('rejects missing from', () => {
    const { from: _, ...noFrom } = validSigningRequest;
    const r = validate(noFrom);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('from'))).toBe(true);
  });

  it('rejects from without did: prefix', () => {
    const r = validate({ ...validSigningRequest, from: 'alice' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('from'))).toBe(true);
  });

  it('rejects to[] with non-DID entry', () => {
    const r = validate({ ...validSigningRequest, to: ['bob'] });
    expect(r.valid).toBe(false);
  });

  it('rejects empty to[]', () => {
    const r = validate({ ...validSigningRequest, to: [] });
    expect(r.valid).toBe(false);
  });

  it('warns on expired message', () => {
    const r = validate({ ...validSigningRequest, expires_time: NOW - 60 });
    expect(r.warnings.some((w) => w.includes('expired'))).toBe(true);
  });

  it('does NOT warn when expires_time is in the future', () => {
    const r = validate({ ...validSigningRequest, expires_time: NOW + 3600 });
    expect(r.warnings.some((w) => w.includes('expired'))).toBe(false);
  });

  it('warns on unknown message type', () => {
    const r = validate({ ...validSigningRequest, type: 'custom/Foo' });
    expect(r.warnings.some((w) => w.includes('Unknown message type'))).toBe(true);
  });

  it('sets messageType in the result', () => {
    const r = validate(validSigningRequest);
    expect(r.messageType).toBe('ac2/SigningRequest');
  });
});

// ─── SigningRequest body ──────────────────────────────────────────────────────

describe('validate() — SigningRequest body', () => {
  it('accepts valid encoding', () => {
    const r = validate({
      ...validSigningRequest,
      body: { ...validSigningRequest.body, encoding: 'base64' },
    });
    expect(r.valid).toBe(true);
  });

  it('rejects invalid encoding', () => {
    const r = validate({
      ...validSigningRequest,
      body: { ...validSigningRequest.body, encoding: 'binary' },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('encoding'))).toBe(true);
  });

  it('rejects empty description', () => {
    const r = validate({
      ...validSigningRequest,
      body: { ...validSigningRequest.body, description: '' },
    });
    expect(r.valid).toBe(false);
  });

  it('rejects body missing all required fields', () => {
    const r = validate({ ...validSigningRequest, body: {} });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('accepts optional schema', () => {
    const r = validate({
      ...validSigningRequest,
      body: { ...validSigningRequest.body, schema: 'https://x402.org/v1' },
    });
    expect(r.valid).toBe(true);
  });

  it('accepts optional key_type', () => {
    expect(
      validate({
        ...validSigningRequest,
        body: { ...validSigningRequest.body, key_type: 'account' },
      }).valid,
    ).toBe(true);
    expect(
      validate({
        ...validSigningRequest,
        body: { ...validSigningRequest.body, key_type: 'identity' },
      }).valid,
    ).toBe(true);
  });

  it('rejects invalid key_type', () => {
    const r = validate({
      ...validSigningRequest,
      body: { ...validSigningRequest.body, key_type: 'master' },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('key_type'))).toBe(true);
  });

  it('accepts optional display_hint', () => {
    for (const hint of ['text', 'json', 'hex']) {
      expect(
        validate({
          ...validSigningRequest,
          body: { ...validSigningRequest.body, display_hint: hint },
        }).valid,
      ).toBe(true);
    }
  });

  it('rejects invalid display_hint', () => {
    const r = validate({
      ...validSigningRequest,
      body: { ...validSigningRequest.body, display_hint: 'binary' },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('display_hint'))).toBe(true);
  });

  it('accepts all valid sig_hint values', () => {
    const hints = [
      'raw-ed25519',
      'raw-secp256k1',
      'message-algorand',
      'message-evm',
      'message-solana',
      'typed-data-evm',
      'transaction-algorand',
      'transaction-evm',
      'transaction-solana',
    ];
    for (const sig_hint of hints) {
      expect(
        validate({ ...validSigningRequest, body: { ...validSigningRequest.body, sig_hint } }).valid,
      ).toBe(true);
    }
  });

  it('rejects an unknown sig_hint value', () => {
    const r = validate({
      ...validSigningRequest,
      body: { ...validSigningRequest.body, sig_hint: 'transaction-bitcoin' },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('sig_hint'))).toBe(true);
  });

  it('rejects unsupported extra fields', () => {
    const r = validate({
      ...validSigningRequest,
      body: { ...validSigningRequest.body, operation: 'algorand-txn' },
    });
    expect(r.valid).toBe(false);
  });
});

// ─── SigningResponse ──────────────────────────────────────────────────────────

describe('validate() — SigningResponse', () => {
  const base = {
    id: 'test-002',
    type: 'ac2/SigningResponse',
    from: 'did:key:bob',
    to: ['did:key:alice'],
    created_time: NOW,
    thid: 'test-001',
    body: {
      signature: 'c2lnbmF0dXJl',
      public_key: 'cHVibGljS2V5',
      address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
      key_type: 'account',
    },
  };

  it('accepts a valid SigningResponse', () => {
    expect(validate(base).valid).toBe(true);
  });

  it('rejects missing signature', () => {
    const { signature: _, ...body } = base.body;
    const r = validate({ ...base, body });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('signature'))).toBe(true);
  });

  it('rejects missing public_key', () => {
    const { public_key: _, ...body } = base.body;
    const r = validate({ ...base, body });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('public_key'))).toBe(true);
  });

  it('rejects invalid key_type', () => {
    const r = validate({
      ...base,
      body: { ...base.body, key_type: 'pending' },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('key_type'))).toBe(true);
  });

  it('rejects unsupported extra fields', () => {
    const r = validate({
      ...base,
      body: { ...base.body, extra: true },
    });
    expect(r.valid).toBe(false);
  });
});

// ─── SigningRejected ─────────────────────────────────────────────────────────

describe('validate() — SigningRejected', () => {
  const base = {
    id: 'test-003',
    type: AC2MessageTypes.SIGNING_REJECTED,
    from: 'did:key:bob',
    to: ['did:key:alice'],
    created_time: NOW,
    thid: 'test-001',
    body: {
      reason: 'User rejected signing request',
    },
  };

  it('validates a correct SigningRejected message', () => {
    const r = validate(base);
    expect(r.valid).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('validateBody validates a correct SigningRejected body', () => {
    const r = validateBody(AC2MessageTypes.SIGNING_REJECTED, base.body);
    expect(r.valid).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });
});

// ─── KeyRequest ───────────────────────────────────────────────────────────────

describe('validate() — KeyRequest', () => {
  const base = {
    id: 'test-004',
    type: 'ac2/KeyRequest',
    from: 'did:key:agent',
    to: ['did:key:user'],
    created_time: NOW,
    body: {
      key_type: 'ed25519',
      purpose: ['sign', 'verify'],
      for_operation: 'algorand-txn',
    },
  };

  it('accepts a key request with documented fields', () => expect(validate(base).valid).toBe(true));

  it('accepts optional derivation_path', () => {
    expect(
      validate({ ...base, body: { ...base.body, derivation_path: "m/44'/283'/0'/0'" } }).valid,
    ).toBe(true);
  });

  it('rejects key request bodies missing required fields', () => {
    expect(
      validate({ ...base, body: { purpose: ['sign'], for_operation: 'algo-txn' } }).valid,
    ).toBe(false);
  });

  it('rejects empty purpose array', () => {
    expect(validate({ ...base, body: { ...base.body, purpose: [] } }).valid).toBe(false);
  });

  it('rejects purpose with invalid enum values', () => {
    const r = validate({ ...base, body: { ...base.body, purpose: ['sign', 'unknownPurpose'] } });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('purpose'))).toBe(true);
  });

  it('rejects unsupported key types', () => {
    expect(validate({ ...base, body: { ...base.body, key_type: 'rsa' } }).valid).toBe(false);
  });

  it('rejects extra key request fields', () => {
    expect(validate({ ...base, body: { ...base.body, any: 'value' } }).valid).toBe(false);
  });
});

// ─── KeyResponse ──────────────────────────────────────────────────────────────

describe('validate() — KeyResponse', () => {
  const base = {
    id: 'test-005',
    type: 'ac2/KeyResponse',
    from: 'did:key:user',
    to: ['did:key:agent'],
    created_time: NOW,
    thid: 'test-004',
    body: {
      status: 'approved',
      key_type: 'ed25519',
      material: 'bWF0ZXJpYWw=',
      public_key: 'cHVibGljS2V5',
    },
  };

  it('accepts a valid approved KeyResponse', () => {
    expect(validate(base).valid).toBe(true);
  });

  it('accepts a rejected response with reason', () => {
    expect(
      validate({
        ...base,
        body: { ...base.body, status: 'rejected', reason: 'Key type not supported' },
      }).valid,
    ).toBe(true);
  });

  it('accepts optional derivation_path', () => {
    expect(
      validate({ ...base, body: { ...base.body, derivation_path: "m/44'/283'/0'/0'" } }).valid,
    ).toBe(true);
  });

  it('rejects invalid status', () => {
    const r = validate({ ...base, body: { ...base.body, status: 'pending' } });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('status'))).toBe(true);
  });

  it('rejects missing material', () => {
    const { material: _, ...body } = base.body;
    const r = validate({ ...base, body });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('material'))).toBe(true);
  });

  it('rejects missing public_key', () => {
    const { public_key: _, ...body } = base.body;
    const r = validate({ ...base, body });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('public_key'))).toBe(true);
  });

  it('rejects unsupported key_type', () => {
    expect(validate({ ...base, body: { ...base.body, key_type: 'rsa' } }).valid).toBe(false);
  });

  it('rejects extra fields', () => {
    expect(validate({ ...base, body: { ...base.body, extra: true } }).valid).toBe(false);
  });
});

// ─── validateBody() ───────────────────────────────────────────────────────────

describe('validateBody()', () => {
  it('returns valid with warning for unknown type', () => {
    const r = validateBody('custom/Unknown', {});
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.includes('No body schema'))).toBe(true);
  });

  it('validates a correct SigningRequest body', () => {
    const r = validateBody(AC2MessageTypes.SIGNING_REQUEST, {
      description: 'test',
      encoding: 'base64',
      payload: 'dGVzdA==',
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects an invalid SigningRequest body', () => {
    const r = validateBody(AC2MessageTypes.SIGNING_REQUEST, { description: 'only this' });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('validates a correct SigningResponse body', () => {
    const r = validateBody(AC2MessageTypes.SIGNING_RESPONSE, {
      signature: 'c2lnbmF0dXJl',
      public_key: 'cHVibGljS2V5',
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects an invalid SigningResponse body', () => {
    const r = validateBody(AC2MessageTypes.SIGNING_RESPONSE, { signature: 'only-sig' });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('validates a correct KeyResponse body', () => {
    const r = validateBody(AC2MessageTypes.KEY_RESPONSE, {
      status: 'approved',
      key_type: 'ed25519',
      material: 'bWF0ZXJpYWw=',
      public_key: 'cHVibGljS2V5',
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects an invalid KeyResponse body', () => {
    const r = validateBody(AC2MessageTypes.KEY_RESPONSE, { public_key: 'only-this' });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
