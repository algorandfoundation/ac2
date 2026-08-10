/**
 * Agent identity-key persistence over the AC2 keystore (OS keychain for secret
 * material, AES-GCM sealed metadata for everything else).
 *
 * Wallet-issued identity keys are stored under their agent DID and are
 * **non-extractable**: the private material never leaves the keystore again, so
 * callers sign through {@link signWithAgentIdentity} instead of reading it back.
 */

import {
  SERVICE_KEY_ID,
  createAc2KeyStore,
  ed25519SeedFromBase64,
  type Ac2KeyStore,
} from '../keystore/index.js';

let keyStore: Ac2KeyStore | undefined;

/** The process-wide AC2 keystore, created on first use. */
export function ac2KeyStore(): Ac2KeyStore {
  if (!keyStore) keyStore = createAc2KeyStore();
  return keyStore;
}

/**
 * Install (or, with `undefined`, drop) the process-wide keystore. The daemon
 * calls this with the instance it also serves over RPC so a single process never
 * opens two engines onto the same keychain entries and metadata blob.
 */
export function setAc2KeyStore(store: Ac2KeyStore | undefined): void {
  keyStore = store;
}

/** Resolve the keystore and wait for the engine (and any migration) to be ready. */
async function ready(): Promise<Ac2KeyStore> {
  const store = ac2KeyStore();
  await store.ready;
  return store;
}


/** Persist a wallet-granted identity (keyed by `agentDid`). Best-effort. */
export async function recordAgentIdentity(params: {
  agentDid: string;
  publicKey: string;
  material: string;
}): Promise<boolean> {
  try {
    const store = await ready();
    await store.keystore.import({
      id: params.agentDid,
      type: 'ed25519',
      algorithm: 'EdDSA',
      extractable: false,
      keyUsages: ['sign', 'verify'],
      publicKey: new Uint8Array(Buffer.from(params.publicKey, 'base64')),
      privateKey: ed25519SeedFromBase64(params.material),
    });
    return true;
  } catch {
    return false;
  }
}

/** True if private material is stored for `agentDid`. */
export async function hasAgentIdentity(agentDid: string): Promise<boolean> {
  try {
    const store = await ready();
    return store.keys.some((key) => key.id === agentDid);
  } catch {
    return false;
  }
}

/** Sign `data` with the identity key stored for `agentDid`, if there is one. */
export async function signWithAgentIdentity(
  agentDid: string,
  data: Uint8Array,
): Promise<Uint8Array | undefined> {
  try {
    const store = await ready();
    return await store.keystore.sign(agentDid, data);
  } catch {
    return undefined;
  }
}

/**
 * Clear every persisted agent identity (`ac2 forget`). The daemon's own service
 * key is kept: it is self-generated, not wallet-issued, and rotating it would
 * change the service DID other agents know it by.
 */
export async function clearAgentIdentities(): Promise<void> {
  try {
    const store = await ready();
    const ids = store.keys.map((key) => key.id).filter((id) => id !== SERVICE_KEY_ID);
    for (const id of ids) {
      try {
        await store.keystore.remove(id);
      } catch {
        // best-effort per key
      }
    }
  } catch {
    // best-effort
  }
}
