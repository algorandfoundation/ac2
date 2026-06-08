/** Ed25519 key operations against the reactive store + encrypted on-disk storage. */

import {
  clearKeyStore,
  generateEd25519FromSeed,
  generateSeedData,
  getKey as getStoreKey,
  InvalidKeyDataError,
  KeyNotFoundError,
  removeKey as removeStoreKey,
  setStatus,
  signWithKeyData,
  verifyWithKeyData,
  type Ed25519KeyData,
  type Key,
  type KeyData,
  type KeyStoreState,
} from '@algorandfoundation/keystore';
import type { Store } from '@tanstack/store';
import type { AuthenticationOptions } from './types.js';
import { clearAll, commit, fetchSecret, removeSecret } from './storage/state.js';

/** Strip private material from a {@link KeyData}, leaving public {@link Key} metadata. */
function toMeta(key: KeyData): Key {
  const { privateKey: _privateKey, ...rest } = key as KeyData & { seed?: unknown };
  delete (rest as { seed?: unknown }).seed;
  return rest as Key;
}

/** Upsert public metadata into the reactive store (replace any existing same id). */
function upsertMeta(store: Store<KeyStoreState>, meta: Key): void {
  store.setState((s) => ({
    ...s,
    keys: [meta, ...s.keys.filter((k) => k.id !== meta.id)],
  }));
}

/** Generate a fresh random id (Ed25519 standalone keys default to this). */
function generateId(): string {
  return `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generate a standalone Ed25519 key, persist it (encrypted), and reflect its
 * public metadata in the reactive store. Returns the new key id.
 */
export async function generate({
  store,
  file,
  id,
  name,
  extractable = true,
  options,
}: {
  store: Store<KeyStoreState>;
  file: string;
  id?: string;
  name?: string;
  extractable?: boolean;
  options?: AuthenticationOptions;
}): Promise<string> {
  setStatus({ store, status: 'generating' });
  try {
    const seed = await generateSeedData({ strength: 128 });
    const keyId = id ?? generateId();
    const key = (await generateEd25519FromSeed(seed, {
      id: keyId,
      ...(name ? { name } : {}),
    })) as Ed25519KeyData;
    const keyData: KeyData = { ...key, extractable };
    await commit({ file, keyData, ...(options ? { options } : {}) });
    upsertMeta(store, toMeta(keyData));
    return keyId;
  } finally {
    setStatus({ store, status: 'idle' });
  }
}

/**
 * Import an existing key (Ed25519 keypair, raw seed, or arbitrary secret key)
 * with its private material, persist it (encrypted), and reflect public
 * metadata in the reactive store. Returns the key id.
 */
export async function importKey({
  store,
  file,
  keyData,
  options,
}: {
  store: Store<KeyStoreState>;
  file: string;
  keyData: KeyData;
  options?: AuthenticationOptions;
}): Promise<string> {
  if (!keyData || typeof keyData !== 'object' || !keyData.type) {
    throw new InvalidKeyDataError('Only KeyData objects with a `type` are supported');
  }
  const supported =
    keyData.type === 'ed25519' || keyData.type === 'seed' || keyData.type === 'secret-key';
  if (!supported) {
    throw new InvalidKeyDataError(
      `Unsupported key type "${keyData.type}" — node-key-store handles ed25519/seed/secret-key only`,
    );
  }
  if (!(keyData.privateKey instanceof Uint8Array)) {
    throw new InvalidKeyDataError('Imported key must carry a Uint8Array privateKey');
  }
  setStatus({ store, status: 'importing' });
  try {
    const keyId = keyData.id ?? generateId();
    const withId: KeyData = {
      ...keyData,
      id: keyId,
      extractable: keyData.extractable ?? true,
    };
    await commit({ file, keyData: withId, ...(options ? { options } : {}) });
    upsertMeta(store, toMeta(withId));
    return keyId;
  } finally {
    setStatus({ store, status: 'idle' });
  }
}

/** Export the full (private-bearing) {@link KeyData} for an extractable key. */
export async function exportKey({
  file,
  id,
  options,
}: {
  file: string;
  id: string;
  options?: AuthenticationOptions;
}): Promise<KeyData> {
  const key = await fetchSecret({ file, keyId: id, ...(options ? { options } : {}) });
  if (!key) throw new KeyNotFoundError(id);
  if (!key.extractable) throw new InvalidKeyDataError('Cannot export a non-extractable key');
  return key;
}

/** Sign `data` with the stored key's private material. */
export async function signData({
  file,
  id,
  data,
  options,
}: {
  file: string;
  id: string;
  data: Uint8Array;
  options?: AuthenticationOptions;
}): Promise<Uint8Array> {
  const key = await fetchSecret({ file, keyId: id, ...(options ? { options } : {}) });
  if (!key) throw new KeyNotFoundError(id);
  return signWithKeyData({ key, data });
}

/** Verify a signature against `data` using the stored key's public material. */
export async function verifyData({
  file,
  id,
  data,
  signature,
  options,
}: {
  file: string;
  id: string;
  data: Uint8Array;
  signature: Uint8Array;
  options?: AuthenticationOptions;
}): Promise<boolean> {
  const key = await fetchSecret({ file, keyId: id, ...(options ? { options } : {}) });
  if (!key) throw new KeyNotFoundError(id);
  return verifyWithKeyData({ key, data, signature });
}

/** Remove a key from both the reactive store and on-disk storage. */
export function removeKey({
  store,
  file,
  keyId,
}: {
  store: Store<KeyStoreState>;
  file: string;
  keyId: string;
}): void {
  removeSecret({ file, keyId });
  removeStoreKey({ store, keyId });
}

/** Clear every key from both the reactive store and on-disk storage. */
export function clear({ store, file }: { store: Store<KeyStoreState>; file: string }): void {
  clearKeyStore({ store });
  clearAll(file);
}

/** Retrieve a key's public metadata from the reactive store. */
export function getKeyMeta({
  store,
  id,
}: {
  store: Store<KeyStoreState>;
  id: string;
}): Key | undefined {
  return getStoreKey({ store, id });
}
