/**
 * Test seams for the AC2 keystore: an in-memory OS-keychain binding and an
 * in-memory sealed-metadata store, so suites exercise the real upstream engine
 * without ever touching the machine's keychain or writing key material to disk.
 */

import type { KeyringBinding, MetadataFile } from '@algorandfoundation/keystore-node';
import {
  createAc2KeyStore,
  type Ac2KeyStore,
  type Ac2KeyStoreOptions,
} from '../../src/keystore/index.js';

/** In-memory {@link KeyringBinding} over a `Map`. */
export function createMemoryKeyring(entries = new Map<string, string>()): KeyringBinding {
  return {
    get: (account) => entries.get(account) ?? null,
    set: (account, secret) => {
      entries.set(account, secret);
    },
    delete: (account) => entries.delete(account),
  };
}

/** In-memory {@link MetadataFile} holding the sealed metadata blob in a closure. */
export function createMemoryMetadataStore(): MetadataFile {
  let bytes: Uint8Array | null = null;
  return {
    read: () => bytes,
    write: (next) => {
      bytes = next;
    },
    remove: () => {
      bytes = null;
    },
  };
}

/**
 * One "machine": a keyring + metadata pair that several keystore instances can
 * share, which is how a restart is simulated.
 */
export interface KeyStoreFixture {
  keyring: KeyringBinding;
  metadata: MetadataFile;
  /** Options to hand to `runDaemon({ keystore })` or `createAc2KeyStore`. */
  options(overrides?: Partial<Ac2KeyStoreOptions>): Ac2KeyStoreOptions;
  /** Build a keystore against this fixture. */
  create(overrides?: Partial<Ac2KeyStoreOptions>): Ac2KeyStore;
}

/** Create a keystore fixture backed by in-memory seams. */
export function createKeyStoreFixture(stateDir?: string): KeyStoreFixture {
  const keyring = createMemoryKeyring();
  const metadata = createMemoryMetadataStore();
  const options = (overrides: Partial<Ac2KeyStoreOptions> = {}): Ac2KeyStoreOptions => ({
    keyring,
    metadata,
    migrateLegacy: false,
    ...(stateDir !== undefined ? { stateDir } : {}),
    ...overrides,
  });
  return {
    keyring,
    metadata,
    options,
    create: (overrides) => createAc2KeyStore(options(overrides)),
  };
}
