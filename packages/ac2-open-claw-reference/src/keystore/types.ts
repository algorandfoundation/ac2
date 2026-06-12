/** Master-key unlock options. */
export interface AuthenticationOptions {
  /** Override the AES master key (skips the keychain fetch). */
  masterKey?: Buffer | Uint8Array;
  /** OS-keychain service name. */
  service?: string;
}

/** Options for {@link createNodeKeyStore}. */
export interface NodeKeyStoreOptions {
  /** Directory for the keystore file (default `$OPENCLAW_STATE_DIR` or `~/.openclaw`). */
  stateDir?: string;
  /** On-disk keystore file name (defaults to `ac2-keystore.json`). */
  fileName?: string;
  /** Master-key / keychain options applied to every operation. */
  authentication?: AuthenticationOptions;
}

/** Resolved storage location for the on-disk keystore. */
export interface StorageLocation {
  /** Absolute path to the keystore JSON file. */
  file: string;
}
