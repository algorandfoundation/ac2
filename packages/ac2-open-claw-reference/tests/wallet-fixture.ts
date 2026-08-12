import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { SessionManager, type ActiveSession } from '../src/session/manager.js';

export interface WalletFixture {
  manager: SessionManager;
  rawPublicKey: Buffer;
  requests: unknown[];
}

/** A fake active session whose "wallet" signs raw-ed25519 with a local key. */
export function walletFixture(
  overrides: Partial<ActiveSession> = {},
  respond?: (args: any) => unknown,
): WalletFixture {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPublicKey = Buffer.from(spki.subarray(spki.length - 32));
  const requests: unknown[] = [];

  const client = {
    async requestSignature(args: any) {
      requests.push(args);
      if (respond) return respond(args);
      const payload = Buffer.from(args.body.payload, 'base64');
      return {
        kind: 'response',
        message: {
          thid: 'thid-1',
          body: {
            signature: cryptoSign(null, payload, privateKey).toString('base64'),
            public_key: rawPublicKey.toString('base64'),
          },
        },
      };
    },
  };

  const manager = new SessionManager();
  manager.setActive({
    transport: {} as never,
    client: client as never,
    controllerDid: 'did:key:controller',
    agentDid: 'did:key:agent',
    identityGranted: true,
    ...overrides,
  });
  return { manager, rawPublicKey, requests };
}
