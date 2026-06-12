/** Factory for a standalone, headless Node keystore instance. */

import { Store } from '@tanstack/store';
import {
  initializeKeyStore,
  type Key,
  type KeyData,
  type KeyStoreState,
} from '@algorandfoundation/keystore';
import type { AuthenticationOptions, NodeKeyStoreOptions } from './types.js';
import { listMeta, resolveKeystoreFile } from './storage/state.js';
import {
  clear as clearStore,
  exportKey,
  generate as generateKey,
  getKeyMeta,
  importKey,
  removeKey as removeStoreKey,
  signData,
  verifyData,
} from './store.js';

/** The keystore operation surface, mirroring `extension.key.store` in RN. */
export interface NodeKeyStoreApi {
  /** Generate a new standalone Ed25519 key. Returns the key id. */
  generate: (params?: { id?: string; name?: string; extractable?: boolean }) => Promise<string>;
  /** Import an existing key (with private material). Returns the key id. */
  import: (keyData: KeyData) => Promise<string>;
  /** Export the full (private-bearing) key data for an extractable key. */
  export: (id: string) => Promise<KeyData>;
  /** Sign bytes with the stored key's private material. */
  sign: (id: string, data: Uint8Array) => Promise<Uint8Array>;
  /** Verify a signature with the stored key's public material. */
  verify: (id: string, data: Uint8Array, signature: Uint8Array) => Promise<boolean>;
  /** Remove a key from the store and disk. */
  remove: (id: string) => void;
  /** Clear all keys from the store and disk. */
  clear: () => void;
  /** Get a key's public metadata from the reactive store. */
  get: (id: string) => Key | undefined;
}

/** A constructed Node keystore instance. */
export interface NodeKeyStore {
  /** Reactive metadata of all keys (UI-safe, no private material). */
  readonly keys: Key[];
  /** Reactive keystore status (`idle`, `generating`, `importing`, …). */
  readonly status: string;
  /** The underlying TanStack store (subscribe for change notifications). */
  readonly store: Store<KeyStoreState>;
  /** Absolute path to the on-disk keystore file. */
  readonly file: string;
  /** The keystore operation surface. */
  readonly key: { store: NodeKeyStoreApi };
}

/**
 * Create a Node keystore bound to an on-disk file (default
 * `~/.openclaw/ac2-keystore.json`). Public metadata is loaded from disk
 * immediately so {@link NodeKeyStore.keys} reflects persisted keys without
 * unlocking the keychain.
 */
export function createNodeKeyStore(options?: NodeKeyStoreOptions): NodeKeyStore {
  const file = resolveKeystoreFile(options);
  const auth: AuthenticationOptions | undefined = options?.authentication;
  const store = new Store<KeyStoreState>({ keys: [], status: 'idle' });

  // Rehydrate public metadata from disk (best-effort; never throws).
  try {
    initializeKeyStore({ store, keys: listMeta(file) });
  } catch {
    initializeKeyStore({ store, keys: [] });
  }

  const api: NodeKeyStoreApi = {
    generate: (params) =>
      generateKey({
        store,
        file,
        ...(params?.id ? { id: params.id } : {}),
        ...(params?.name ? { name: params.name } : {}),
        ...(params?.extractable !== undefined ? { extractable: params.extractable } : {}),
        ...(auth ? { options: auth } : {}),
      }),
    import: (keyData) => importKey({ store, file, keyData, ...(auth ? { options: auth } : {}) }),
    export: (id) => exportKey({ file, id, ...(auth ? { options: auth } : {}) }),
    sign: (id, data) => signData({ file, id, data, ...(auth ? { options: auth } : {}) }),
    verify: (id, data, signature) =>
      verifyData({ file, id, data, signature, ...(auth ? { options: auth } : {}) }),
    remove: (id) => removeStoreKey({ store, file, keyId: id }),
    clear: () => clearStore({ store, file }),
    get: (id) => getKeyMeta({ store, id }),
  };

  return {
    get keys() {
      return store.state.keys;
    },
    get status() {
      return store.state.status;
    },
    store,
    file,
    key: { store: api },
  };
}
