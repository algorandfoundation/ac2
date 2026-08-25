/** Resolve the public Algorand account bound to an active AC2 session. */

import { encodeAddress, isValidAddress } from '@algorandfoundation/algokit-utils/common';

import { extractEd25519PublicKey } from '@algorandfoundation/ac2-cli/identity';
import type { ActiveSession } from './manager.js';

/** Recover an Algorand account from a controller DID when no linked address is available. */
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

/**
 * The minimum an AC2 connection has to expose for its Algorand account to be
 * resolvable. Deliberately structural (not {@link ActiveSession}) so the same
 * rule applies to a connection the DAEMON owns — where the only facts we get
 * back over the control socket are the controller DID and the wallet address
 * it reported — as to an in-process pairing session.
 */
export interface WalletAccountFacts {
  controllerDid: string;
  walletAddress?: string | null;
}

/** Return the validated public Algorand account for a connection's facts. */
export function walletAccountAlgorandAddress(facts: WalletAccountFacts): string | undefined {
  if (facts.walletAddress && isValidAddress(facts.walletAddress)) {
    return facts.walletAddress;
  }
  return controllerDidToAlgorandAddress(facts.controllerDid);
}

/** Return the validated public Algorand account associated with an active session. */
export function sessionAlgorandAddress(active: ActiveSession): string | undefined {
  return walletAccountAlgorandAddress(active);
}
