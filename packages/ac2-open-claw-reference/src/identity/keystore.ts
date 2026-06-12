/** Agent identity-key persistence over the Node keystore (OS-keychain + AES file). */

import { createNodeKeyStore, type NodeKeyStore } from '../keystore/index.js';

let keyStore: NodeKeyStore | undefined;

function store(): NodeKeyStore {
  if (!keyStore) keyStore = createNodeKeyStore();
  return keyStore;
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function toBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

/** Persist a wallet-granted identity (keyed by `agentDid`). Best-effort. */
export async function recordAgentIdentity(params: {
  agentDid: string;
  publicKey: string;
  material: string;
}): Promise<boolean> {
  try {
    await store().key.store.import({
      id: params.agentDid,
      type: 'ed25519',
      algorithm: 'EdDSA',
      extractable: true,
      publicKey: fromBase64(params.publicKey),
      privateKey: fromBase64(params.material),
    });
    return true;
  } catch {
    return false;
  }
}

/** True if private material is stored for `agentDid`. */
export function hasAgentIdentity(agentDid: string): boolean {
  try {
    return store().key.store.get(agentDid) !== undefined;
  } catch {
    return false;
  }
}

/** Stored private material for `agentDid` (base64), or `undefined`. */
export async function getAgentIdentityMaterial(agentDid: string): Promise<string | undefined> {
  try {
    const key = await store().key.store.export(agentDid);
    return key.privateKey ? toBase64(key.privateKey) : undefined;
  } catch {
    return undefined;
  }
}

/** Clear every persisted agent identity (`ac2 forget`). */
export function clearAgentIdentities(): void {
  try {
    store().key.store.clear();
  } catch {
    // best-effort
  }
}
