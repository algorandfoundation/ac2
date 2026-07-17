/** Resolve the public Algorand account bound to an active AC2 session. */

import { encodeAddress, isValidAddress } from '@algorandfoundation/algokit-utils/common';

import { extractEd25519PublicKey } from '../identity/did.js';
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

/** Return the validated public Algorand account associated with an active session. */
export function sessionAlgorandAddress(active: ActiveSession): string | undefined {
  if (active.walletAddress && isValidAddress(active.walletAddress)) {
    return active.walletAddress;
  }
  return controllerDidToAlgorandAddress(active.controllerDid);
}
