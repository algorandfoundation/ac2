/** Where the keystore keeps its sealed metadata, and which keychain it uses. */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  KEYCHAIN_SERVICE_PREFIX,
  LEGACY_KEYSTORE_FILE,
  METADATA_FILE,
} from './constants.js';

/**
 * Resolve the AC2 state directory. Checks `$AC2_STATE_DIR` first, then falls
 * back to the legacy `$OPENCLAW_STATE_DIR`, then `~/.openclaw` — the same
 * resolution the persisted connection state uses, so identities and keys always
 * live side by side.
 */
export function resolveKeystoreStateDir(stateDir?: string): string {
  const explicit = stateDir?.trim();
  if (explicit) return explicit;
  const ac2StateDirEnv = process.env['AC2_STATE_DIR']?.trim();
  if (ac2StateDirEnv) return ac2StateDirEnv;
  const openClawStateDirEnv = process.env['OPENCLAW_STATE_DIR']?.trim();
  return openClawStateDirEnv ? openClawStateDirEnv : join(homedir(), '.openclaw');
}

/** Absolute path of the AES-GCM sealed metadata blob for `stateDir`. */
export function resolveMetadataPath(stateDir: string): string {
  return join(stateDir, METADATA_FILE);
}

/**
 * OS-keychain service name for `stateDir`. Stable per directory: the same AC2
 * home always reuses the same keychain entries across restarts, while separate
 * homes (parallel test runs, a staging profile) never collide.
 */
export function resolveKeychainService(stateDir: string): string {
  const digest = createHash('sha256').update(stateDir).digest('hex').slice(0, 16);
  return `${KEYCHAIN_SERVICE_PREFIX}-${digest}`;
}

/** Absolute path of the pre-migration, AES-256-GCM encrypted keystore file. */
export function resolveLegacyKeystoreFile(stateDir: string): string {
  return join(stateDir, LEGACY_KEYSTORE_FILE);
}
