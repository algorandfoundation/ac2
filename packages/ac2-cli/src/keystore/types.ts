/** Public types of the AC2 keystore wiring. */

import type {
  Key,
  KeyringBinding,
  KeyStoreState,
  MetadataFile,
  NodeKeyStore,
} from '@algorandfoundation/keystore-node';
import type { Store } from '@tanstack/store';

/** Options for {@link createAc2KeyStore}. */
export interface Ac2KeyStoreOptions {
  /**
   * State directory the keystore belongs to. Defaults to `$AC2_STATE_DIR`, then
   * `$OPENCLAW_STATE_DIR`, then `~/.openclaw`.
   */
  stateDir?: string;
  /** Override the sealed-metadata path (defaults to one inside `stateDir`). */
  metadataPath?: string;
  /** Override the OS-keychain service (defaults to one derived from `stateDir`). */
  service?: string;
  /** Inject an OS-keychain binding — tests use an in-memory fake. */
  keyring?: KeyringBinding;
  /** Inject a metadata store — tests use an in-memory fake. */
  metadata?: MetadataFile;
  /** Reuse an existing reactive store (e.g. one shared with the RPC server). */
  store?: Store<KeyStoreState>;
  /** Skip the one-time legacy-keystore migration (default: run it). */
  migrateLegacy?: boolean;
  /** Legacy AES master key, for migrating without touching the OS keychain. */
  legacyMasterKey?: Buffer | Uint8Array;
  /** Progress / diagnostics sink. */
  log?: (line: string) => void;
}

/** A ready-to-use AC2 keystore. */
export interface Ac2KeyStore {
  /** The upstream keystore API (`generate`, `import`, `sign`, `secrets`, …). */
  readonly keystore: NodeKeyStore;
  /** Reactive metadata store backing {@link keys} (never private material). */
  readonly store: Store<KeyStoreState>;
  /** OS-keychain service the key material is filed under. */
  readonly service: string;
  /** Path of the AES-GCM sealed metadata blob (unused when `metadata` is injected). */
  readonly metadataPath: string;
  /** Reactive metadata of every stored key. */
  readonly keys: Key[];
  /** Reactive keystore status (`idle`, `generating`, `importing`, …). */
  readonly status: string;
  /** Resolves once the engine is open and any legacy data has been migrated. */
  readonly ready: Promise<void>;
}
