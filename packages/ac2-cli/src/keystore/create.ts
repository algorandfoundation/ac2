/**
 * The AC2 keystore: the upstream `@algorandfoundation/keystore-node` engine
 * wired to AC2's state directory.
 *
 * AC2 has no storage engine of its own any more. Secret key material lives in
 * the OS keychain (chunked, encrypted at rest by the platform) and all UI-safe
 * metadata in one AES-GCM sealed blob next to the connection state; the reactive
 * store only ever mirrors metadata. On first use any data left by the previous,
 * AC2-owned storage engine is migrated in (see {@link migrateLegacyKeystore}).
 */

import { createNodeKeyStore, type KeyStoreState } from '@algorandfoundation/keystore-node';
import { Store } from '@tanstack/store';
import { migrateLegacyKeystore } from './migrate.js';
import { resolveKeychainService, resolveKeystoreStateDir, resolveMetadataPath } from './paths.js';
import type { Ac2KeyStore, Ac2KeyStoreOptions } from './types.js';

/**
 * Build an AC2 keystore. Construction is synchronous; await
 * {@link Ac2KeyStore.ready} before the first operation so the engine is open and
 * the legacy migration (if any) has run.
 */
export function createAc2KeyStore(options: Ac2KeyStoreOptions = {}): Ac2KeyStore {
  const stateDir = resolveKeystoreStateDir(options.stateDir);
  const service = options.service ?? resolveKeychainService(stateDir);
  const metadataPath = options.metadataPath ?? resolveMetadataPath(stateDir);
  const store = options.store ?? new Store<KeyStoreState>({ keys: [], status: 'idle' });
  const log = options.log ?? ((): void => {});

  const keystore = createNodeKeyStore({
    store,
    service,
    ...(options.keyring ? { keyring: options.keyring } : {}),
    ...(options.metadata ? { metadata: options.metadata } : { metadataPath }),
  });

  const ready = (async (): Promise<void> => {
    await keystore.ready;
    if (options.migrateLegacy === false) return;
    try {
      await migrateLegacyKeystore({
        keystore,
        stateDir,
        log,
        ...(options.legacyMasterKey ? { masterKey: options.legacyMasterKey } : {}),
      });
    } catch (err) {
      // A failed migration must never keep the daemon from starting: the legacy
      // file is left untouched and the next start retries.
      log(`[ac2] legacy keystore migration failed: ${(err as Error).message}`);
    }
  })();

  return {
    keystore,
    store,
    service,
    metadataPath,
    get keys() {
      return store.state.keys;
    },
    get status() {
      return store.state.status;
    },
    ready,
  };
}
