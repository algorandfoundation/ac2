/**
 * Resolve the git signing public key of the paired AC2 account. Signing
 * itself needs no git configuration — see `./sign.ts`; committer identity is
 * the user's own `git config user.name`/`user.email`.
 */

import { decodeAddress } from '@algorandfoundation/algokit-utils/common';

import { loadAc2State } from '@algorandfoundation/ac2-cli/identity';
import { sessionManager, type SessionManager } from '../session/manager.js';
import {
  controllerDidToAlgorandAddress,
  sessionAlgorandAddress,
} from '../session/wallet-address.js';

/**
 * The paired account's Ed25519 public key, used as the git signing public
 * key. An Algorand address *is* the account's Ed25519 public key, so decoding
 * it yields the public key directly. Falls back to the persisted
 * bound controller when no session is live (e.g. a fresh CLI process).
 */
export function resolveWalletSigningPublicKey(
  manager: SessionManager = sessionManager,
): { address: string; publicKey: Uint8Array } | undefined {
  const active = manager.getActive();
  const boundControllerDid = loadAc2State().identity?.controllerDid;
  const address = active
    ? sessionAlgorandAddress(active)
    : boundControllerDid
      ? controllerDidToAlgorandAddress(boundControllerDid)
      : undefined;
  if (!address) return undefined;
  return { address, publicKey: decodeAddress(address).publicKey };
}

export const NO_WALLET_KEY_MESSAGE =
  'No signing public key available: pair a wallet first (`openclaw ac2 pair`) ' +
  "so the controller's public key is known.";
