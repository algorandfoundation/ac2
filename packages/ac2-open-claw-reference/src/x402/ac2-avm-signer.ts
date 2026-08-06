/** AC2-backed Algorand signer adapter for x402's AVM client scheme. */

import { Buffer } from 'node:buffer';

import {
  bytesForSigning,
  decodeTransaction,
  encodeSignedTransaction,
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

export { controllerDidToAlgorandAddress } from '../session/wallet-address.js';

export const X402_ALGORAND_SIGNING_SCHEMA =
  'x402/exact/algorand/v2/transaction-signing-bytes';

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

function buildSigningDescription(args: { readonly paymentContext?: X402PaymentContext }): string {
  const resource = args.paymentContext?.resource;
  const title = `Approve x402 payment for ${resourceName(resource)}.`;

  return [title, resourceDetails(resource)].filter(Boolean).join('\n');
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
        const result = await resolveSign(
          {
            description: buildSigningDescription({
              ...(paymentContext !== undefined ? { paymentContext } : {}),
            }),
            payload_base64: base64(signingBytes),
            schema: X402_ALGORAND_SIGNING_SCHEMA,
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
