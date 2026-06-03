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
  it('accepts all valid encodings', () => {
    for (const enc of ['base64', 'hex', 'utf8', 'cbor']) {
      const r = validate({
        ...validSigningRequest,
        body: { ...validSigningRequest.body, encoding: enc },
      });
      expect(r.valid).toBe(true);
    }
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
      status: 'approved',
      signature: 'c2lnbmF0dXJl',
      timestamp: '2026-01-01T00:00:00Z',
    },
  };

  it('accepts a valid SigningResponse', () => {
    expect(validate(base).valid).toBe(true);
  });

  it('rejects missing status', () => {
    const { status: _, ...body } = base.body;
    const r = validate({ ...base, body });
    expect(r.valid).toBe(false);
  });

  it('rejects invalid status', () => {
    const r = validate({
      ...base,
      body: { ...base.body, status: 'pending' },
    });
    expect(r.valid).toBe(false);
  });

  it('rejects missing signature', () => {
    const { signature: _, ...body } = base.body;
    const r = validate({ ...base, body });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('signature'))).toBe(true);
  });

  it('rejects missing timestamp', () => {
    const { timestamp: _, ...body } = base.body;
    const r = validate({ ...base, body });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('timestamp'))).toBe(true);
  });

  it('rejects unsupported extra fields', () => {
    const r = validate({
      ...base,
      body: { ...base.body, extra: true },
    });
    expect(r.valid).toBe(false);
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
      purpose: 'Algorand identity',
      for_operation: 'algorand-txn',
    },
  };

  it('accepts a key request with documented fields', () => expect(validate(base).valid).toBe(true));
  it('rejects key request bodies missing required fields', () => {
    expect(validate({ ...base, body: { purpose: 'Algorand identity' } }).valid).toBe(false);
  });

  it('rejects unsupported key types', () => {
    expect(validate({ ...base, body: { ...base.body, key_type: 'rsa' } }).valid).toBe(false);
  });

  it('rejects extra key request fields', () => {
    expect(validate({ ...base, body: { ...base.body, any: 'value' } }).valid).toBe(false);
  });
});

// ─── SessionEstablish ─────────────────────────────────────────────────────────

describe('validate() — SessionEstablish', () => {
  const base = {
    id: 'test-005',
    type: 'ac2/SessionEstablish',
    from: 'did:key:agent',
    to: ['did:key:user'],
    created_time: NOW,
    body: { protocol_version: '1.0' },
  };

  it('accepts SessionEstablish with documented fields', () =>
    expect(validate(base).valid).toBe(true));
  it('accepts SessionEstablish with arbitrary fields', () => {
    const r = validate({ ...base, body: { protocol_version: 'v1', any: true } });
    expect(r.valid).toBe(true);
  });
});

// ─── StreamChunk ──────────────────────────────────────────────────────────────

describe('validate() — StreamChunk', () => {
  const base = {
    id: 'test-006',
    type: 'ac2/StreamChunk',
    from: 'did:key:agent',
    to: ['did:key:user'],
    created_time: NOW,
    body: {
      stream_id: 'stream-1',
      sequence: 0,
      content: 'Hello world',
      content_type: 'text',
    },
  };

  it('accepts a StreamChunk with documented fields', () => expect(validate(base).valid).toBe(true));
  it('accepts optional is_last and usage', () => {
    const r = validate({
      ...base,
      body: { ...base.body, is_last: true, usage: { input_tokens: 5, output_tokens: 10 } },
    });
    expect(r.valid).toBe(true);
  });
  it('accepts arbitrary StreamChunk fields', () => {
    const r = validate({ ...base, body: { random: 'field', sequence: 'not-number' } });
    expect(r.valid).toBe(true);
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
});
