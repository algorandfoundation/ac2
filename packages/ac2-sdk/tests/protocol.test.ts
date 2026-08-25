/// <reference types="vitest/globals" />

import {
  createKeyRequest,
  createKeyResponse,
  createSigningRequest,
  createSigningResponse,
  createSigningRejected,
  handleMessage,
  defaultMessageHandlers,
  type MessageHandlerMap,
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
  it('dispatches messages to the matching type-keyed handler', async () => {
    const calls: string[] = [];

    const handlers: MessageHandlerMap = {
      'ac2/SigningRequest': async () => {
        calls.push('signing-request');
      },
      'ac2/SigningResponse': async () => {
        calls.push('signing-response');
      },
      'ac2/SigningRejected': async () => {
        calls.push('signing-rejected');
      },
      'ac2/KeyRequest': async () => {
        calls.push('key-request');
      },
      'ac2/KeyResponse': async () => {
        calls.push('key-response');
      },
    };

    await handleMessage(
      createSigningRequest(envelope, {
        description: 'Sign this payload',
        encoding: 'base64',
        payload: 'dGVzdA==',
      }),
      { handlers },
    );

    await handleMessage(
      createSigningResponse(envelope, {
        signature: 'c2lnbmF0dXJl',
        public_key: 'cHVibGljS2V5',
        address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
        key_type: 'account',
      }),
      { handlers },
    );

    await handleMessage(
      createSigningRejected(envelope, {
        reason: 'User rejected the signing request',
      }),
      { handlers },
    );

    await handleMessage(
      createKeyRequest(envelope, {
        key_type: 'ed25519',
        purpose: ['sign'],
        for_operation: 'algorand-txn',
      }),
      { handlers },
    );

    await handleMessage(
      createKeyResponse(envelope, {
        status: 'approved',
        key_type: 'ed25519',
        material: 'bWF0ZXJpYWw=',
        public_key: 'cHVibGljS2V5',
        derivation_path: "m/44'/283'/0'/0",
      }),
      { handlers },
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

  it('routes unregistered (extension) types to onUnknown', async () => {
    const seen: string[] = [];

    // A valid envelope but with an extension `type` the SDK does not know.
    const extensionMessage = {
      ...envelope,
      id: 'ext-001',
      type: 'com.acme.payment.request',
      body: { amount: 100, currency: 'USD' },
    };

    await handleMessage(extensionMessage as any, {
      handlers: {
        'ac2/SigningRequest': () => {
          seen.push('should-not-fire');
        },
      },
      onUnknown: (msg) => {
        seen.push(`unknown:${msg.type}`);
      },
    });

    expect(seen).toEqual(['unknown:com.acme.payment.request']);
  });

  it('supports registering handlers for extension types via the open map', async () => {
    const seen: string[] = [];

    const extensionMessage = {
      ...envelope,
      id: 'ext-002',
      type: 'com.acme.payment.request',
      body: { amount: 42, currency: 'USD' },
    };

    await handleMessage(extensionMessage as any, {
      handlers: {
        'com.acme.payment.request': (msg) => {
          seen.push(`paid:${msg.id}`);
        },
      },
    });

    expect(seen).toEqual(['paid:ext-002']);
  });

  it('lets consumer handlers override defaults via object spread', async () => {
    const seen: string[] = [];

    const merged: MessageHandlerMap = {
      ...defaultMessageHandlers,
      'ac2/SigningRequest': (msg) => {
        seen.push(`overridden:${msg.id}`);
      },
    };

    await handleMessage(
      createSigningRequest(envelope, {
        description: 'Sign this payload',
        encoding: 'base64',
        payload: 'dGVzdA==',
      }),
      { handlers: merged },
    );

    expect(seen).toEqual([`overridden:${envelope.id}`]);
  });
});
