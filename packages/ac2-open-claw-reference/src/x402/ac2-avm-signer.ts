/** AC2-backed Algorand signer adapter for x402's AVM client scheme. */

import { Buffer } from 'node:buffer';

import {
  bytesForSigning,
  decodeTransaction,
  encodeSignedTransaction,
  encodeTransactionRaw,
  type Transaction,
} from '@algorandfoundation/algokit-utils/transact';
import type { ClientAvmSigner } from '@x402/avm';
import type { PaymentRequirements, ResourceInfo } from '@x402/core/types';

import type { PluginConfig, ToolContext } from '../session/contracts.js';
import {
  resolveSign,
  resolveWalletAccount,
  type ResolveSignDeps,
} from '../session/flows.js';
import { NoActiveSessionError } from '../session/manager.js';
import { walletAccountAlgorandAddress } from '../session/wallet-address.js';
import { X402SwapInsufficientAlgoError, X402SwapUnavailableError } from './swap.js';

export { controllerDidToAlgorandAddress } from '../session/wallet-address.js';

export const X402_ALGORAND_SIGNING_SCHEMA =
  'x402/exact/algorand/v2/transaction-signing-bytes';

/**
 * Schema for signing a whole atomic group in ONE request. The payload is a
 * sequence of length-prefixed frames — for each transaction, a 4-byte
 * big-endian byte length followed by the unsigned transaction msgpack
 * (`encodeTransactionRaw`) — and the wallet returns the concatenated 64-byte
 * Ed25519 signatures in the same order. The AC2 envelope is unchanged —
 * payload/signature are opaque bytes — so this is a payload convention, not a
 * protocol change. Wallets that don't understand it raw-sign the blob and
 * return a single 64-byte signature, which the signer detects and falls back
 * to per-transaction requests.
 */
export const X402_ALGORAND_GROUP_SIGNING_SCHEMA =
  'x402/exact/algorand/v2/transaction-group';

/** Encode a group payload for {@link X402_ALGORAND_GROUP_SIGNING_SCHEMA}. */
export function encodeTransactionGroupPayload(txns: readonly Transaction[]): Uint8Array {
  const frames = txns.map((txn) => encodeTransactionRaw(txn));
  const out = new Uint8Array(frames.reduce((n, frame) => n + 4 + frame.length, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.length, false);
    out.set(frame, offset + 4);
    offset += 4 + frame.length;
  }
  return out;
}

/** Split a {@link X402_ALGORAND_GROUP_SIGNING_SCHEMA} payload back into transactions. */
export function decodeTransactionGroupPayload(payload: Uint8Array): Transaction[] {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const txns: Transaction[] = [];
  let offset = 0;
  while (offset < payload.length) {
    if (offset + 4 > payload.length) {
      throw new Error('Malformed transaction group payload: truncated length prefix.');
    }
    const length = view.getUint32(offset, false);
    offset += 4;
    if (offset + length > payload.length) {
      throw new Error('Malformed transaction group payload: truncated transaction frame.');
    }
    txns.push(decodeTransaction(payload.subarray(offset, offset + length)));
    offset += length;
  }
  if (txns.length === 0) {
    throw new Error('Malformed transaction group payload: no transactions.');
  }
  return txns;
}

export interface X402PaymentContext {
  readonly requirements?: PaymentRequirements;
  readonly resource?: ResourceInfo;
}

export interface Ac2AvmSignerOptions {
  readonly config: PluginConfig;
  /**
   * Seams for the connection lookup and the signing round-trip. Both accept a
   * local session manager (an in-process `ac2 pair` session) AND a
   * daemon control-socket `connect`, because the daemon — not this process —
   * normally owns the wallet connection.
   */
  readonly deps?: ResolveSignDeps;
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


function decodeUnsignedTransaction(txnBytes: Uint8Array, index: number): Transaction {
  try {
    return decodeTransaction(txnBytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to decode x402 Algorand transaction at index ${index}: ${msg}`);
  }
}

function resourceName(resource?: ResourceInfo): string {
  const name = resource?.description ?? resource?.serviceName;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'paid resource';
}

function resourceDetails(resource?: ResourceInfo): string {
  if (!resource) return '';
  const parts = [resource.url, resource.mimeType].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
  return parts.length > 0 ? `Resource: ${parts.join(' · ')}` : '';
}

function buildGroupSigningDescription(args: {
  readonly count: number;
  readonly paymentContext?: X402PaymentContext;
}): string {
  const resource = args.paymentContext?.resource;
  const title = `Approve x402 payment for ${resourceName(resource)}.`;
  const groupLine = `One atomic group of ${args.count} transactions — approve once to sign all; everything settles together or nothing does.`;
  return [title, groupLine, resourceDetails(resource)].filter(Boolean).join('\n');
}

function buildSigningDescription(args: {
  readonly txnIndex: number;
  readonly groupSize: number;
  readonly paymentContext?: X402PaymentContext;
}): string {
  const resource = args.paymentContext?.resource;
  const title = `Approve x402 payment for ${resourceName(resource)}.`;
  // The wallet decodes and previews each transaction itself; what it cannot
  // know is the position in the atomic group (e.g. opt-in + swap + payment),
  // so spell that out when the payment is more than a single transaction.
  const groupLine =
    args.groupSize > 1
      ? `Transaction ${args.txnIndex + 1} of ${args.groupSize} in one atomic group — all settle together or nothing does.`
      : '';

  return [title, groupLine, resourceDetails(resource)].filter(Boolean).join('\n');
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

/**
 * Build an x402 AVM signer backed by the connected AC2 wallet.
 *
 * ASYNC BY NECESSITY: both halves of this signer now resolve through whichever
 * process owns the connection — the payer address comes from
 * {@link resolveWalletAccount} and each signature from {@link resolveSign},
 * which broker over the daemon control socket when this process has no local
 * pairing session (the norm in the agent/gateway process where tools run).
 * Previously both read `sessionManager.requireActive()` synchronously, so x402
 * payments always failed with `no_active_session` even with a live wallet.
 */
export async function createAc2AvmSigner(
  options: Ac2AvmSignerOptions,
): Promise<ClientAvmSigner> {
  const account = await resolveWalletAccount(options.config, options.deps ?? {});
  if (!account) {
    throw new NoActiveSessionError(
      'No AC2 wallet connection. Ask the user to run `openclaw ac2 pair` and connect their wallet first.',
    );
  }
  const address = walletAccountAlgorandAddress(account);
  if (!address) throw new X402ControllerAddressError(account.controllerDid);

  async function requestSignature(request: {
    description: string;
    payload: Uint8Array;
    schema: string;
  }): Promise<Uint8Array> {
    const result = await resolveSign(
      {
        description: request.description,
        payload_base64: base64(request.payload),
        schema: request.schema,
        sig_hint: 'transaction-algorand',
        display_hint: 'hex',
        key_type: 'account',
      },
      options.config,
      options.deps ?? {},
      options.context ?? {},
    );
    if (result.status === 'rejected') {
      throw new X402SigningRejectedError(result.reason);
    }
    if (result.address !== undefined && result.address !== address) {
      throw new Error(`Wallet signed x402 transaction with ${result.address}, expected ${address}.`);
    }
    return new Uint8Array(Buffer.from(result.signature, 'base64'));
  }

  /**
   * One approval for the whole group: payload = `encodeTransactions(txns)`,
   * expected reply = concatenated per-transaction signatures in order.
   * Returns null when the wallet answered with a single 64-byte signature —
   * a legacy build that raw-signed the blob (that signature is meaningless
   * on-chain and is discarded) — so the caller can fall back to one request
   * per transaction. A user rejection propagates: declining the group is
   * declining the payment, not a capability probe.
   */
  async function trySignGroup(
    entries: ReadonlyArray<{ index: number; txn: Transaction }>,
    paymentContext: X402PaymentContext | undefined,
  ): Promise<Uint8Array[] | null> {
    const txns = entries.map((e) => e.txn);
    const sigBlob = await requestSignature({
      description: buildGroupSigningDescription({
        count: txns.length,
        ...(paymentContext !== undefined ? { paymentContext } : {}),
      }),
      payload: encodeTransactionGroupPayload(txns),
      schema: X402_ALGORAND_GROUP_SIGNING_SCHEMA,
    });
    if (sigBlob.length === 64 * txns.length) {
      return txns.map((txn, k) =>
        encodeSignedTransaction({
          txn,
          sig: new Uint8Array(sigBlob.subarray(k * 64, (k + 1) * 64)),
        }),
      );
    }
    if (sigBlob.length === 64) return null;
    throw new Error(
      `Wallet returned ${sigBlob.length} bytes for a ${txns.length}-transaction group; ` +
        `expected ${64 * txns.length} (one Ed25519 signature per transaction).`,
    );
  }

  return {
    address,
    async signTransactions(
      txns: Uint8Array[],
      indexesToSign?: number[],
    ): Promise<(Uint8Array | null)[]> {
      const signerIndexes = normalizeIndexes(indexesToSign, txns.length);
      const paymentContext = options.getPaymentContext?.();

      // Decode and validate every transaction we are asked to sign up front,
      // so a bad group fails before any wallet approval is requested.
      const entries: Array<{ index: number; txn: Transaction }> = [];
      for (let i = 0; i < txns.length; i++) {
        if (!signerIndexes.has(i)) continue;
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
        entries.push({ index: i, txn });
      }

      const signed: (Uint8Array | null)[] = txns.map(() => null);

      if (entries.length > 1) {
        options.context?.signal?.throwIfAborted();
        const groupSigned = await trySignGroup(entries, paymentContext);
        if (groupSigned) {
          entries.forEach((entry, k) => {
            signed[entry.index] = groupSigned[k] as Uint8Array;
          });
          return signed;
        }
      }

      for (let k = 0; k < entries.length; k++) {
        options.context?.signal?.throwIfAborted();
        const { index, txn } = entries[k] as { index: number; txn: Transaction };
        const signature = await requestSignature({
          description: buildSigningDescription({
            txnIndex: k,
            groupSize: entries.length,
            ...(paymentContext !== undefined ? { paymentContext } : {}),
          }),
          payload: bytesForSigning.transaction(txn),
          schema: X402_ALGORAND_SIGNING_SCHEMA,
        });
        assertSignature(signature, index);
        signed[index] = encodeSignedTransaction({ txn, sig: signature });
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
  if (err instanceof X402SwapUnavailableError || err instanceof X402SwapInsufficientAlgoError) {
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
