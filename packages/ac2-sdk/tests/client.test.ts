/// <reference types="vitest/globals" />

import { Ac2Client } from '../src/client';
import { createInMemoryTransportPair } from '../src/transport';
import { createSigningResponse, createSigningRejected, createKeyResponse } from '../src/protocol';

const NOW = Math.floor(Date.now() / 1000);

describe('Ac2Client request/response primitive', () => {
  it('requestSignature resolves with a SigningResponse paired by thid', async () => {
    const [a, b] = createInMemoryTransportPair();
    const agent = new Ac2Client(a);

    // Peer side: as soon as we see the request, respond.
    b.onMessage((msg) => {
      const response = createSigningResponse(
        {
          id: 'resp-1',
          from: 'did:key:user',
          to: ['did:key:agent'],
          created_time: NOW,
          thid: msg.id,
        },
        {
          signature: 'c2ln',
          public_key: 'cGs=',
          address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
          key_type: 'account',
        },
      );
      b.send(JSON.stringify(response));
    });

    const outcome = await agent.requestSignature({
      from: 'did:key:agent',
      to: 'did:key:user',
      body: { description: 'sign', encoding: 'base64', payload: 'dGVzdA==' },
    });

    expect(outcome.kind).toBe('response');
  });

  it('requestSignature also resolves on SigningRejected', async () => {
    const [a, b] = createInMemoryTransportPair();
    const agent = new Ac2Client(a);

    b.onMessage((msg) => {
      const rejected = createSigningRejected(
        {
          id: 'rej-1',
          from: 'did:key:user',
          to: ['did:key:agent'],
          created_time: NOW,
          thid: msg.id,
        },
        { reason: 'no' },
      );
      b.send(JSON.stringify(rejected));
    });

    const outcome = await agent.requestSignature({
      from: 'did:key:agent',
      to: 'did:key:user',
      body: { description: 'sign', encoding: 'base64', payload: 'dGVzdA==' },
    });

    expect(outcome.kind).toBe('rejected');
  });

  it('requestKey resolves with the matching KeyResponse', async () => {
    const [a, b] = createInMemoryTransportPair();
    const agent = new Ac2Client(a);

    b.onMessage((msg) => {
      const response = createKeyResponse(
        {
          id: 'kr-1',
          from: 'did:key:user',
          to: ['did:key:agent'],
          created_time: NOW,
          thid: msg.id,
        },
        {
          status: 'approved',
          key_type: 'ed25519',
          material: 'bWF0',
          public_key: 'cGs=',
          derivation_path: "m/44'/283'/0'/0",
        },
      );
      b.send(JSON.stringify(response));
    });

    const response = await agent.requestKey({
      from: 'did:key:agent',
      to: 'did:key:user',
      body: { key_type: 'ed25519', purpose: ['sign'], for_operation: 'algo' },
    });

    expect(response.body.status).toBe('approved');
  });

  it('does not settle a waiter when an unrelated type arrives on the same thid', async () => {
    const [a, b] = createInMemoryTransportPair();
    const seen: string[] = [];
    const agent = new Ac2Client(a, {
      handlers: {
        'ac2/SigningResponse': (msg) => {
          seen.push(`fallthrough:${msg.id}`);
        },
      },
    });

    b.onMessage((msg) => {
      // A SigningResponse arrives in reply to a requestKey — wrong type
      // for that waiter. It MUST NOT settle the key waiter; it MUST
      // fall through to the type-keyed handler instead.
      const response = createSigningResponse(
        {
          id: 'wrong-1',
          from: 'did:key:user',
          to: ['did:key:agent'],
          created_time: NOW,
          thid: msg.id,
        },
        {
          signature: 'c2ln',
          public_key: 'cGs=',
          address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
          key_type: 'account',
        },
      );
      b.send(JSON.stringify(response));
    });

    const keyPromise = agent.requestKey(
      {
        from: 'did:key:agent',
        to: 'did:key:user',
        body: { key_type: 'ed25519', purpose: ['sign'], for_operation: 'algo' },
      },
      { timeoutMs: 50 },
    );

    await expect(keyPromise).rejects.toThrow(/timed out/);
    expect(seen).toEqual(['fallthrough:wrong-1']);
  });
});

describe('Ac2Client responder helpers (wallet side)', () => {
  it('onSigningRequest approves end-to-end via two Ac2Clients', async () => {
    const [a, b] = createInMemoryTransportPair();
    const agent = new Ac2Client(a);
    const wallet = new Ac2Client(b);

    wallet.onSigningRequest((req) => ({
      kind: 'approve',
      body: {
        signature: 'c2ln',
        public_key: 'cGs=',
        address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
        key_type: 'account',
      },
    }));

    const outcome = await agent.requestSignature({
      from: 'did:key:agent',
      to: 'did:key:user',
      body: { description: 'sign', encoding: 'base64', payload: 'dGVzdA==' },
    });

    expect(outcome.kind).toBe('response');
    if (outcome.kind === 'response') {
      expect(outcome.message.body.signature).toBe('c2ln');
    }
  });

  it('onSigningRequest rejects with a reason', async () => {
    const [a, b] = createInMemoryTransportPair();
    const agent = new Ac2Client(a);
    const wallet = new Ac2Client(b);

    wallet.onSigningRequest(() => ({ kind: 'reject', reason: 'user declined' }));

    const outcome = await agent.requestSignature({
      from: 'did:key:agent',
      to: 'did:key:user',
      body: { description: 'sign', encoding: 'base64', payload: 'dGVzdA==' },
    });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.message.body.reason).toBe('user declined');
    }
  });

  it('onKeyRequest replies with the supplied KeyResponse body', async () => {
    const [a, b] = createInMemoryTransportPair();
    const agent = new Ac2Client(a);
    const wallet = new Ac2Client(b);

    wallet.onKeyRequest(() => ({
      status: 'approved',
      key_type: 'ed25519',
      material: 'bWF0',
      public_key: 'cGs=',
      derivation_path: "m/44'/283'/0'/0",
    }));

    const response = await agent.requestKey({
      from: 'did:key:agent',
      to: 'did:key:user',
      body: { key_type: 'ed25519', purpose: ['sign'], for_operation: 'algo' },
    });

    expect(response.body.status).toBe('approved');
    if (response.body.status === 'approved') {
      expect(response.body.material).toBe('bWF0');
    }
  });

  it('responder errors are routed to onError and no reply is sent', async () => {
    const [a, b] = createInMemoryTransportPair();
    const agent = new Ac2Client(a);
    const errs: Error[] = [];
    const wallet = new Ac2Client(b, { onError: (e) => errs.push(e) });

    wallet.onSigningRequest(() => {
      throw new Error('boom');
    });

    const outcome = agent.requestSignature(
      {
        from: 'did:key:agent',
        to: 'did:key:user',
        body: { description: 'sign', encoding: 'base64', payload: 'dGVzdA==' },
      },
      { timeoutMs: 50 },
    );

    await expect(outcome).rejects.toThrow(/timed out/);
    expect(errs.map((e) => e.message)).toContain('boom');
  });
});
