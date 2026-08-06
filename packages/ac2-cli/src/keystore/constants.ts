/** Logging / context tag for the AC2 keystore wiring. */
export const context = '@algorandfoundation/ac2-keystore';

/**
 * Prefix of the OS-keychain service every key entry is filed under. The state
 * directory is hashed into the suffix so one machine can host several
 * independent AC2 homes (tests, staging, …) without colliding.
 */
export const KEYCHAIN_SERVICE_PREFIX = 'ac2-keystore';

/** File name of the upstream keystore's AES-GCM sealed metadata blob. */
export const METADATA_FILE = 'ac2-keystore-metadata.bin';

/** File name of the dedicated macOS keychain (see `darwin-keyring.ts`). */
export const KEYCHAIN_FILE = 'ac2-keystore.keychain-db';

/** File name of the `0600` file holding the dedicated keychain's password. */
export const KEYCHAIN_KEY_FILE = 'ac2-keystore.keychain-key';

/** Keystore id of the daemon's own, self-generated service identity. */
export const SERVICE_KEY_ID = 'ac2-service';

/** File name of the pre-migration, AES-256-GCM encrypted keystore. */
export const LEGACY_KEYSTORE_FILE = 'ac2-keystore.json';

/** OS-keychain service the legacy AES master key was filed under. */
export const LEGACY_KEYCHAIN_SERVICE = 'ac2-app-secret';

/** OS-keychain account the legacy AES master key was filed under. */
export const LEGACY_MASTER_KEY_ACCOUNT = 'master';

/** Suffix appended to the legacy keystore file once it has been migrated. */
export const LEGACY_BACKUP_SUFFIX = '.migrated';
