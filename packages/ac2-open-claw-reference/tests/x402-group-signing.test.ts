import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { Address } from '@algorandfoundation/algokit-utils/common';
import {
  bytesForSigning,
  decodeSignedTransaction,
  groupTransactions,
  encodeTransactionRaw,
  OnApplicationComplete,
  Transaction,
  TransactionType,
} from '@algorandfoundation/algokit-utils/transact';
import { publicKeyToDidKey } from '@algorandfoundation/ac2-cli/identity';

import { SessionManager, createAc2AvmSigner } from '../src/index.js';
import {
  decodeTransactionGroupPayload,
  encodeTransactionGroupPayload,
  X402_ALGORAND_GROUP_SIGNING_SCHEMA,
  X402_ALGORAND_SIGNING_SCHEMA,
  X402SigningRejectedError,
} from '../src/x402/ac2-avm-signer.js';

const SENDER = new Address(new Uint8Array(32).fill(1));
const RECEIVER = new Address(new Uint8Array(32).fill(2));
const AGENT_DID = publicKeyToDidKey(new Uint8Array(32).fill(9));

function baseFields() {
  return {
    sender: SENDER,
    fee: 1_000n,
    firstValid: 1n,
    lastValid: 1_000n,
    genesisHash: new Uint8Array(32).fill(3),
    genesisId: 'testnet-v1.0',
  };
}

function sampleGroup(): Transaction[] {
  return groupTransactions([
    new Transaction({
      ...baseFields(),
      type: TransactionType.AssetTransfer,
      assetTransfer: { assetId: 10_458_941n, amount: 0n, receiver: SENDER },
    }),
    new Transaction({
      ...baseFields(),
      type: TransactionType.Payment,
      payment: { receiver: RECEIVER, amount: 3_000_000n },
    }),
    new Transaction({
      ...baseFields(),
      fee: 2_000n,
      type: TransactionType.AppCall,
      appCall: { appId: 148_607_000n, onComplete: OnApplicationComplete.NoOp },
    }),
    new Transaction({
      ...baseFields(),
      type: TransactionType.AssetTransfer,
      assetTransfer: { assetId: 10_458_941n, amount: 1_000_000n, receiver: RECEIVER },
    }),
  ]);
}

/**
 * Wallet stub: records every SigningRequest and answers via `respond`,
 * which receives the decoded request args.
 */
function managerWith(
  respond: (args: { body: { payload: string; schema?: string } }, call: number) => string,
): { manager: SessionManager; requests: Array<{ body: { payload: string; schema?: string; description: string } }> } {
  const requests: Array<{ body: { payload: string; schema?: string; description: string } }> = [];
  const manager = new SessionManager();
  manager.setActive({
    transport: {} as never,
    client: {
      requestSignature: async (args: never) => {
        const request = args as { body: { payload: string; schema?: string; description: string } };
        requests.push(request);
        return {
          kind: 'response',
          message: {
            thid: `thread-${requests.length}`,
            body: {
              signature: respond(request, requests.length),
              public_key: Buffer.from(SENDER.publicKey).toString('base64'),
              address: SENDER.toString(),
              key_type: 'account',
            },
          },
        };
      },
    } as never,
    controllerDid: publicKeyToDidKey(SENDER.publicKey),
    agentDid: AGENT_DID,
  });
  return { manager, requests };
}

describe('transaction group payload codec', () => {
  it('round-trips a grouped transaction set', () => {
    const txns = sampleGroup();
    const decoded = decodeTransactionGroupPayload(encodeTransactionGroupPayload(txns));
    expect(decoded).toHaveLength(4);
    decoded.forEach((txn, i) => {
      expect(txn.txId()).toBe(txns[i]?.txId());
      expect(txn.group).toBeInstanceOf(Uint8Array);
    });
  });

  it('rejects truncated payloads', () => {
    const payload = encodeTransactionGroupPayload(sampleGroup());
    expect(() => decodeTransactionGroupPayload(payload.subarray(0, payload.length - 3))).toThrow(
      /truncated/,
    );
    expect(() => decodeTransactionGroupPayload(new Uint8Array(0))).toThrow(/no transactions/);
  });
});

describe('x402 group signing', () => {
  it('signs a whole group with ONE wallet approval when the wallet supports it', async () => {
    const txns = sampleGroup();
    const { manager, requests } = managerWith((request) => {
      // Group-aware wallet: split the payload, sign each transaction.
      const decoded = decodeTransactionGroupPayload(
        new Uint8Array(Buffer.from(request.body.payload, 'base64')),
      );
      const sigs = decoded.map((_txn, i) => new Uint8Array(64).fill(i + 1));
      return Buffer.concat(sigs).toString('base64');
    });

    const signer = await createAc2AvmSigner({
      config: { defaultTimeoutMs: 2_000 },
      deps: { manager },
    });
    const signed = await signer.signTransactions(
      txns.map((txn) => encodeTransactionRaw(txn)),
      [0, 1, 2, 3],
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.schema).toBe(X402_ALGORAND_GROUP_SIGNING_SCHEMA);
    expect(requests[0]?.body.description).toContain('One atomic group of 4 transactions');
    signed.forEach((stxnBytes, i) => {
      const stxn = decodeSignedTransaction(stxnBytes as Uint8Array);
      expect(stxn.txn.txId()).toBe(txns[i]?.txId());
      expect(Buffer.from(stxn.sig ?? new Uint8Array()).equals(Buffer.from(new Uint8Array(64).fill(i + 1)))).toBe(
        true,
      );
    });
  });

  it('falls back to per-transaction requests when the wallet raw-signs the blob', async () => {
    const txns = sampleGroup();
    const { manager, requests } = managerWith((request, call) => {
      if (call === 1) {
        // Legacy wallet: one 64-byte signature over the whole payload.
        return Buffer.from(new Uint8Array(64).fill(200)).toString('base64');
      }
      // Per-transaction follow-ups: sign the provided signing bytes marker.
      return Buffer.from(new Uint8Array(64).fill(call)).toString('base64');
    });

    const signer = await createAc2AvmSigner({
      config: { defaultTimeoutMs: 2_000 },
      deps: { manager },
    });
    const signed = await signer.signTransactions(
      txns.map((txn) => encodeTransactionRaw(txn)),
      [0, 1, 2, 3],
    );

    // 1 group attempt + 4 per-transaction requests.
    expect(requests).toHaveLength(5);
    expect(requests[0]?.body.schema).toBe(X402_ALGORAND_GROUP_SIGNING_SCHEMA);
    for (let i = 1; i < 5; i++) {
      expect(requests[i]?.body.schema).toBe(X402_ALGORAND_SIGNING_SCHEMA);
      expect(requests[i]?.body.payload).toBe(
        Buffer.from(bytesForSigning.transaction(txns[i - 1] as Transaction)).toString('base64'),
      );
    }
    signed.forEach((stxnBytes, i) => {
      const stxn = decodeSignedTransaction(stxnBytes as Uint8Array);
      expect(stxn.txn.txId()).toBe(txns[i]?.txId());
      expect(stxn.sig?.[0]).toBe(i + 2);
    });
  });

  it('does not use the group path for a single transaction', async () => {
    const txns = sampleGroup().slice(3);
    const { manager, requests } = managerWith(() =>
      Buffer.from(new Uint8Array(64).fill(5)).toString('base64'),
    );

    const signer = await createAc2AvmSigner({
      config: { defaultTimeoutMs: 2_000 },
      deps: { manager },
    });
    await signer.signTransactions([encodeTransactionRaw(txns[0] as Transaction)], [0]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.schema).toBe(X402_ALGORAND_SIGNING_SCHEMA);
  });

  it('propagates a rejection of the group request without retrying per transaction', async () => {
    const txns = sampleGroup();
    const requests: unknown[] = [];
    const manager = new SessionManager();
    manager.setActive({
      transport: {} as never,
      client: {
        requestSignature: async (args: never) => {
          requests.push(args);
          return {
            kind: 'rejected',
            message: { thid: 'thread-1', body: { reason: 'declined' } },
          };
        },
      } as never,
      controllerDid: publicKeyToDidKey(SENDER.publicKey),
      agentDid: AGENT_DID,
    });

    const signer = await createAc2AvmSigner({
      config: { defaultTimeoutMs: 2_000 },
      deps: { manager },
    });
    await expect(
      signer.signTransactions(
        txns.map((txn) => encodeTransactionRaw(txn)),
        [0, 1, 2, 3],
      ),
    ).rejects.toThrow(X402SigningRejectedError);
    expect(requests).toHaveLength(1);
  });
});
