/** AC2-backed Algorand signer adapter for x402's AVM client scheme. */

import { Buffer } from 'node:buffer';

import { encodeAddress, isValidAddress } from '@algorandfoundation/algokit-utils/common';
import {
  bytesForSigning,
  decodeTransaction,
  encodeSignedTransaction,
  TransactionType,
  type Transaction,
} from '@algorandfoundation/algokit-utils/transact';
import type { ClientAvmSigner } from '@x402/avm';
import type { PaymentRequirements, ResourceInfo } from '@x402/core/types';

import { extractEd25519PublicKey } from '../identity/did.js';
import type { PluginConfig, ToolContext } from '../session/contracts.js';
import { signFlow, type SignDeps } from '../session/flows.js';
import {
  NoActiveSessionError,
  sessionManager,
  type ActiveSession,
  type SessionManager,
} from '../session/manager.js';

export const X402_ALGORAND_SIGNING_SCHEMA =
  'x402/exact/algorand/v2/transaction-signing-bytes';

export interface X402PaymentContext {
  readonly requirements?: PaymentRequirements;
  readonly resource?: ResourceInfo;
}

export interface Ac2AvmSignerOptions {
  readonly config: PluginConfig;
  readonly deps?: SignDeps;
  readonly context?: ToolContext;
  readonly getPaymentContext?: () => X402PaymentContext | undefined;
}

export class X402SigningRejectedError extends Error {
  readonly code = 'x402_signing_rejected' as const;
  constructor(reason: string) {
    super(`x402 payment signing rejected: ${reason}`);
    this.name = 'X402SigningRejectedError';
  }
}

export class X402ControllerAddressError extends Error {
  readonly code = 'x402_controller_address_unavailable' as const;
  constructor(controllerDid: string) {
    super(`Active AC2 controller DID is not an Algorand account address: ${controllerDid}`);
    this.name = 'X402ControllerAddressError';
  }
}

function managerFromDeps(deps?: SignDeps): SessionManager {
  return deps?.manager ?? sessionManager;
}

export function controllerDidToAlgorandAddress(controllerDid: string): string | undefined {
  const raw = controllerDid.startsWith('did:key:')
    ? controllerDid.slice('did:key:'.length)
    : controllerDid;
  if (isValidAddress(raw)) return raw;

  const publicKey = extractEd25519PublicKey(controllerDid);
  if (!publicKey) return undefined;
  const address = encodeAddress(publicKey);
  return isValidAddress(address) ? address : undefined;
}

function sessionAlgorandAddress(active: ActiveSession): string | undefined {
  if (active.walletAddress && isValidAddress(active.walletAddress)) {
    return active.walletAddress;
  }
  return controllerDidToAlgorandAddress(active.controllerDid);
}

function decodeUnsignedTransaction(txnBytes: Uint8Array, index: number): Transaction {
  try {
    return decodeTransaction(txnBytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to decode x402 Algorand transaction at index ${index}: ${msg}`);
  }
}

function formatAmount(amount: bigint | undefined): string {
  return amount === undefined ? 'unknown amount' : amount.toString();
}

function summarizeTransaction(txn: Transaction): string {
  if (txn.type === TransactionType.AssetTransfer && txn.assetTransfer) {
    const xfer = txn.assetTransfer;
    return [
      'ASA transfer',
      `asset ${xfer.assetId.toString()}`,
      `amount ${formatAmount(xfer.amount)}`,
      `to ${xfer.receiver.toString()}`,
    ].join(' · ');
  }

  if (txn.type === TransactionType.Payment && txn.payment) {
    const payment = txn.payment;
    return [
      'ALGO payment',
      `${formatAmount(payment.amount)} microAlgos`,
      `to ${payment.receiver.toString()}`,
    ].join(' · ');
  }

  return `Algorand ${txn.type} transaction`;
}

function formatResource(resource?: ResourceInfo): string {
  if (!resource) return '';
  const parts = [
    resource.description,
    resource.serviceName,
    resource.url,
    resource.mimeType,
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return parts.length > 0 ? `\nResource: ${parts.join(' · ')}` : '';
}

function buildSigningDescription(args: {
  readonly txn: Transaction;
  readonly txnIndex: number;
  readonly groupSize: number;
  readonly signerAddress: string;
  readonly paymentContext?: X402PaymentContext;
}): string {
  const req = args.paymentContext?.requirements;
  const requirementLine = req
    ? [
        `x402 exact payment`,
        `network ${req.network}`,
        `asset ${req.asset}`,
        `amount ${req.amount}`,
        `payTo ${req.payTo}`,
      ].join(' · ')
    : 'x402 exact Algorand payment';

  return [
    requirementLine,
    `Sign transaction ${args.txnIndex + 1} of ${args.groupSize} as ${args.signerAddress}.`,
    summarizeTransaction(args.txn),
    `Sender: ${args.txn.sender.toString()}`,
    formatResource(args.paymentContext?.resource),
  ]
    .filter(Boolean)
    .join('\n');
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function normalizeIndexes(indexesToSign: number[] | undefined, groupSize: number): Set<number> {
  if (indexesToSign === undefined) {
    return new Set(Array.from({ length: groupSize }, (_v, i) => i));
  }
  return new Set(indexesToSign);
}

function assertSignature(bytes: Uint8Array, index: number): void {
  if (bytes.length !== 64) {
    throw new Error(
      `Wallet returned ${bytes.length} bytes for x402 transaction ${index + 1}; expected a 64-byte Ed25519 signature.`,
    );
  }
}

export function createAc2AvmSigner(options: Ac2AvmSignerOptions): ClientAvmSigner {
  const manager = managerFromDeps(options.deps);
  const active = manager.requireActive();
  const address = sessionAlgorandAddress(active);
  if (!address) throw new X402ControllerAddressError(active.controllerDid);

  return {
    address,
    async signTransactions(
      txns: Uint8Array[],
      indexesToSign?: number[],
    ): Promise<(Uint8Array | null)[]> {
      const signerIndexes = normalizeIndexes(indexesToSign, txns.length);
      const signed: (Uint8Array | null)[] = [];

      for (let i = 0; i < txns.length; i++) {
        options.context?.signal?.throwIfAborted();
        if (!signerIndexes.has(i)) {
          signed.push(null);
          continue;
        }

        const unsignedBytes = txns[i];
        if (!unsignedBytes) {
          throw new Error(`Missing x402 Algorand transaction at index ${i}.`);
        }

        const txn = decodeUnsignedTransaction(unsignedBytes, i);
        const sender = txn.sender.toString();
        if (sender !== address) {
          throw new Error(
            `x402 transaction ${i + 1} has sender ${sender}, but the active AC2 wallet is ${address}.`,
          );
        }

        const signingBytes = bytesForSigning.transaction(txn);
        const paymentContext = options.getPaymentContext?.();
        const result = await signFlow(
          {
            description: buildSigningDescription({
              txn,
              txnIndex: i,
              groupSize: txns.length,
              signerAddress: address,
              ...(paymentContext !== undefined ? { paymentContext } : {}),
            }),
            payload_base64: base64(signingBytes),
            schema: X402_ALGORAND_SIGNING_SCHEMA,
            sig_hint: 'raw-ed25519',
            display_hint: 'hex',
            key_type: 'account',
          },
          options.config,
          options.deps,
          options.context,
        );

        if (result.status === 'rejected') {
          throw new X402SigningRejectedError(result.reason);
        }
        if (result.address !== undefined && result.address !== address) {
          throw new Error(
            `Wallet signed x402 transaction with ${result.address}, expected ${address}.`,
          );
        }

        const signature = new Uint8Array(Buffer.from(result.signature, 'base64'));
        assertSignature(signature, i);
        signed.push(encodeSignedTransaction({ txn, sig: signature }));
      }

      return signed;
    },
  };
}

export function classifyX402SigningError(err: unknown):
  | { status: 'rejected'; reason: string }
  | { status: 'error'; reason: string } {
  if (err instanceof NoActiveSessionError) {
    return { status: 'rejected', reason: err.code };
  }
  if (err instanceof X402SigningRejectedError) {
    return { status: 'rejected', reason: err.message };
  }
  if (err instanceof X402ControllerAddressError) {
    return { status: 'error', reason: err.message };
  }

  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('no_active_session')) {
    return { status: 'rejected', reason: 'no_active_session' };
  }
  if (message.includes('x402 payment signing rejected')) {
    return { status: 'rejected', reason: message };
  }
  return { status: 'error', reason: message };
}
