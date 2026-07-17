/** Cross-process-safe durable pairing invitation creation. */

import {
  createPairingInvitation,
  isLiquidAuthPairingCredential,
  type LiquidAuthPairingCredential,
} from '../providers/liquid-auth.js';
import { loadAc2State, saveAc2State, withAc2StateLock } from './state.js';

/** Bound invitation HTTP work while the cross-process pairing lock is held. */
export const PAIRING_INVITATION_TIMEOUT_MS = 15_000;

export interface EnsuredPairing {
  pairing: LiquidAuthPairingCredential;
  created: boolean;
}

export async function ensurePersistedPairing(
  origin: string,
  requestId?: string,
  signal?: AbortSignal,
): Promise<EnsuredPairing> {
  return withAc2StateLock(async () => {
    const state = loadAc2State();
    if (state.pairing !== undefined) {
      if (!isLiquidAuthPairingCredential(state.pairing)) {
        throw new Error('[ac2] Persisted pairing credential is invalid');
      }
      return { pairing: state.pairing, created: false };
    }
    const pairing = await createPairingInvitation(origin, requestId ?? state.requestId, signal);
    saveAc2State({
      pairing,
      requestId: pairing.pairingId,
      activeRequestId: pairing.pairingId,
    });
    return { pairing, created: true };
  }, signal);
}
