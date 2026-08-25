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
import { createDefaultDarwinKeyring } from './darwin-keyring.js';
import {
  assertPersistentKeyStorage,
  createHardenedNapiKeyring,
  ensureSessionBusAddress,
} from './napi-keyring.js';
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

  // On macOS the default is a dedicated, self-unlocked AC2 keychain: the login
  // keychain is locked in the headless contexts the daemon runs in (launchd,
  // SSH) and every access there fails with "User interaction is not allowed".
  // Everywhere else, a hardened `@napi-rs/keyring` binding that never masks a
  // hard keychain failure (e.g. Secret Service down) as a missing key.
  let keyring = options.keyring ?? createDefaultDarwinKeyring({ stateDir, service, log });
  if (!keyring) {
    // A daemon started outside a desktop login session (SSH, or auto-started
    // from one) inherits no `DBUS_SESSION_BUS_ADDRESS`, so it cannot see the
    // Secret Service running under `user@<uid>.service` and would fall back to
    // the volatile kernel keyring on a machine that HAS a working keychain.
    const busAddress = ensureSessionBusAddress();
    if (busAddress !== null) log(`[ac2] using the systemd user session bus at ${busAddress}`);
    keyring = createHardenedNapiKeyring({ service });
    // `@napi-rs/keyring` silently falls back to the VOLATILE kernel keyring on
    // Linux when no Secret Service is reachable; keys stored there are wiped on
    // logout/reboot. Fail construction instead of storing keys that evaporate.
    assertPersistentKeyStorage(keyring);
  }

  const keystore = createNodeKeyStore({
    store,
    service,
    keyring,
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
  // `ready` starts running eagerly (the engine's own ready check kicks off at
  // construction). Attach a no-op handler so an early rejection — e.g. "master
  // key is missing from the keychain" — surfaces to whoever awaits `ready`
  // (the daemon's startup path, which reports it) instead of killing the
  // process as an unhandled rejection before that await is reached.
  ready.catch(() => {});

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
