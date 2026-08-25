/// <reference types="vitest/globals" />

import {
  AC2MessageTypes,
  baseMessageSchema,
  decode,
  keyRequestBodySchema,
  keyResponseBodySchema,
  signingRejectedBodySchema,
  signingRequestBodySchema,
  signingResponseBodySchema,
  validate,
  validateBody,
  validateMessage,
} from '../src/schema';

const NOW = Math.floor(Date.now() / 1000);

const validSigningRequest = {
  id: 'schema-001',
  type: AC2MessageTypes.SIGNING_REQUEST,
  from: 'did:key:alice',
  to: ['did:key:bob'],
  created_time: NOW,
  body: {
    description: 'Sign this payload',
    encoding: 'base64',
    payload: 'dGVzdA==',
  },
};

describe('schema exports', () => {
  it('exposes the base message schema', () => {
    expect(baseMessageSchema.type).toBe('object');
    expect(baseMessageSchema.required).toContain('id');
    expect(baseMessageSchema.required).toContain('body');
    expect(baseMessageSchema.properties['to']?.type).toBe('array');
  });

  it('exposes the signing and key body schemas', () => {
    expect(signingRequestBodySchema.required).toEqual(['description', 'encoding', 'payload']);
    expect(signingResponseBodySchema.required).toEqual(['signature', 'public_key']);
    expect(signingResponseBodySchema.properties.signature?.type).toBe('string');
    expect(signingResponseBodySchema.properties.public_key?.type).toBe('string');
    expect(signingRejectedBodySchema.required).toEqual(['reason']);
    expect(signingRejectedBodySchema.properties.reason?.type).toBe('string');
    expect(keyRequestBodySchema.additionalProperties).toBe(false);
    expect(keyResponseBodySchema.additionalProperties).toBe(false);
    expect(keyResponseBodySchema.required).toEqual([
      'status',
      'key_type',
      'material',
      'public_key',
    ]);
  });
});

describe('schema helpers', () => {
  it('validateMessage matches validate for a valid message', () => {
    expect(validateMessage(validSigningRequest).valid).toBe(true);
    expect(validate(validSigningRequest).valid).toBe(true);
  });

  it('decode returns a validation result for a JSON string', () => {
    const { validation, message } = decode(JSON.stringify(validSigningRequest));
    expect(validation.valid).toBe(true);
    expect(message.type).toBe(AC2MessageTypes.SIGNING_REQUEST);
  });

  it('validateBody accepts and rejects signing bodies', () => {
    expect(
      validateBody(AC2MessageTypes.SIGNING_REQUEST, {
        description: 'Sign this payload',
        encoding: 'base64',
        payload: 'dGVzdA==',
      }).valid,
    ).toBe(true);

    expect(validateBody(AC2MessageTypes.KEY_REQUEST, {} as never).valid).toBe(false);
  });
});
