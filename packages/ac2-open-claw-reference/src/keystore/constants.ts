/** Logging / context tag for this keystore implementation. */
export const context = '@algorandfoundation/node-key-store';

/** Default OS-keychain service the AES master key is stored under. */
export const DEFAULT_KEYCHAIN_SERVICE = 'ac2-app-secret';

/** Keychain account/username the master key is stored under. */
export const MASTER_KEY_ACCOUNT = 'master';

/** Default file name for the on-disk keystore (under the OpenClaw state dir). */
export const DEFAULT_KEYSTORE_FILE = 'ac2-keystore.json';
