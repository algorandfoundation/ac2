/// <reference types="vitest/globals" />

import {
  createKeyRequest,
  createKeyResponse,
  createSigningRequest,
  createSigningResponse,
  createSigningRejected,
  handleMessage,
} from '../src/protocol';
import { AC2MessageTypes } from '../src/schema';

const NOW = Math.floor(Date.now() / 1000);

const envelope = {
  id: 'proto-001',
  from: 'did:key:alice',
  to: ['did:key:bob'],
  created_time: NOW,
  expires_time: NOW + 60,
  thid: 'thread-1',
  pthid: 'parent-1',
  attachments: [{ id: 'att-1', data: { json: { hello: 'world' } } }],
};

describe('protocol factories', () => {
  it('creates a signing request with the base envelope fields', () => {
    const message = createSigningRequest(envelope, {
      description: 'Sign this payload',
      encoding: 'base64',
      payload: 'dGVzdA==',
    });

    expect(message.type).toBe(AC2MessageTypes.SIGNING_REQUEST);
    expect(message.expires_time).toBe(envelope.expires_time);
    expect(message.thid).toBe(envelope.thid);
    expect(message.pthid).toBe(envelope.pthid);
    expect(message.attachments).toEqual(envelope.attachments);
    expect(message.body.description).toBe('Sign this payload');
  });

  it('creates the other protocol message variants', () => {
    const signingResponse = createSigningResponse(envelope, {
      signature: 'c2lnbmF0dXJl',
      public_key: 'cHVibGljS2V5',
      address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
      key_type: 'account',
    });
    const signingRejected = createSigningRejected(envelope, {
      reason: 'User rejected the signing request',
    });
    const keyRequest = createKeyRequest(envelope, {
      key_type: 'ed25519',
      purpose: ['sign'],
      for_operation: 'algorand-txn',
    });
    const keyResponse = createKeyResponse(envelope, {
      status: 'approved',
      key_type: 'ed25519',
      material: 'bWF0ZXJpYWw=',
      public_key: 'cHVibGljS2V5',
      derivation_path: "m/44'/283'/0'/0",
    });

    expect(signingResponse.type).toBe(AC2MessageTypes.SIGNING_RESPONSE);
    expect(signingRejected.type).toBe(AC2MessageTypes.SIGNING_REJECTED);
    expect(keyRequest.type).toBe(AC2MessageTypes.KEY_REQUEST);
    expect(keyResponse.type).toBe(AC2MessageTypes.KEY_RESPONSE);
  });
});

describe('handleMessage()', () => {
  it('dispatches to the matching handlers', async () => {
    const calls: string[] = [];

    await handleMessage(
      createSigningRequest(envelope, {
        description: 'Sign this payload',
        encoding: 'base64',
        payload: 'dGVzdA==',
      }),
      {
        onSigningRequest: async () => {
          calls.push('signing-request');
        },
        onSigningResponse: async () => {
          calls.push('signing-response');
        },
        onKeyRequest: async () => {
          calls.push('key-request');
        },
        onKeyResponse: async () => {
          calls.push('key-response');
        },
      },
    );

    await handleMessage(
      createSigningResponse(envelope, {
        signature: 'c2lnbmF0dXJl',
        public_key: 'cHVibGljS2V5',
        address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
        key_type: 'account',
      }),
      {
        onSigningRequest: async () => {
          calls.push('signing-request');
        },
        onSigningResponse: async () => {
          calls.push('signing-response');
        },
        onSigningRejected: async () => {
          calls.push('signing-rejected');
        },
        onKeyRequest: async () => {
          calls.push('key-request');
        },
        onKeyResponse: async () => {
          calls.push('key-response');
        },
      },
    );

    await handleMessage(
      createSigningRejected(envelope, {
        reason: 'User rejected the signing request',
      }),
      {
        onSigningRequest: async () => {
          calls.push('signing-request');
        },
        onSigningResponse: async () => {
          calls.push('signing-response');
        },
        onSigningRejected: async () => {
          calls.push('signing-rejected');
        },
        onKeyRequest: async () => {
          calls.push('key-request');
        },
        onKeyResponse: async () => {
          calls.push('key-response');
        },
      },
    );

    await handleMessage(
      createKeyRequest(envelope, {
        key_type: 'ed25519',
        purpose: ['sign'],
        for_operation: 'algorand-txn',
      }),
      {
        onSigningRequest: async () => {
          calls.push('signing-request');
        },
        onSigningResponse: async () => {
          calls.push('signing-response');
        },
        onSigningRejected: async () => {
          calls.push('signing-rejected');
        },
        onKeyRequest: async () => {
          calls.push('key-request');
        },
        onKeyResponse: async () => {
          calls.push('key-response');
        },
      },
    );

    await handleMessage(
      createKeyResponse(envelope, {
        status: 'approved',
        key_type: 'ed25519',
        material: 'bWF0ZXJpYWw=',
        public_key: 'cHVibGljS2V5',
        derivation_path: "m/44'/283'/0'/0",
      }),
      {
        onSigningRequest: async () => {
          calls.push('signing-request');
        },
        onSigningResponse: async () => {
          calls.push('signing-response');
        },
        onSigningRejected: async () => {
          calls.push('signing-rejected');
        },
        onKeyRequest: async () => {
          calls.push('key-request');
        },
        onKeyResponse: async () => {
          calls.push('key-response');
        },
      },
    );

    expect(calls).toEqual([
      'signing-request',
      'signing-response',
      'signing-rejected',
      'key-request',
      'key-response',
    ]);
  });

  it('routes invalid messages to onUnknown', async () => {
    const calls: Array<{ valid: boolean }> = [];

    await handleMessage(
      { type: 'ac2/SigningRequest' },
      {
        onUnknown: async (_msg, validation) => {
          calls.push(validation);
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.valid).toBe(false);
  });
});
