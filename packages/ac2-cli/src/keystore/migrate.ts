/**
 * One-time migration of the pre-migration AC2 keystore into the upstream
 * `@algorandfoundation/keystore-node` engine.
 *
 * AC2 used to ship its own storage engine: an AES-256-GCM encrypted
 * `ac2-keystore.json` next to the connection state, wrapped under a master key
 * in the OS keychain. The upstream keystore stores secret material in the OS
 * keychain directly (plus a sealed metadata blob), so that engine is gone — this
 * module lifts whatever it held into the new keystore under the *same key ids*,
 * so service and agent DIDs survive the upgrade.
 *
 * The migration is idempotent and conservative: entries already present in the
 * new keystore are left alone, and the legacy file is only renamed to a
 * `.migrated` backup once every entry has been accounted for. Anything that
 * fails leaves the file exactly where it is so the next start can retry.
 */

import { existsSync, renameSync } from 'node:fs';
import type { KeyData, KeyStoreAPI } from '@algorandfoundation/keystore-node';
import { LEGACY_BACKUP_SUFFIX } from './constants.js';
import { decryptLegacyEntry, readLegacyKeystoreFile, readLegacyMasterKey } from './legacy.js';
import { toEd25519Seed } from './material.js';
import { resolveKeystoreStateDir, resolveLegacyKeystoreFile } from './paths.js';

/** A legacy entry that was not migrated, and why. */
export interface LegacyMigrationSkip {
  /** Keystore id of the legacy entry. */
  id: string;
  /** Human-readable reason (already present, unsupported type, failure, …). */
  reason: string;
}

/** Outcome of a legacy keystore migration. */
export interface LegacyMigrationResult {
  /** Absolute path of the legacy file that was processed. */
  file: string;
  /** Key ids lifted into the new keystore. */
  migrated: string[];
  /** Entries that were not migrated. */
  skipped: LegacyMigrationSkip[];
  /** Path the legacy file was moved to, or `null` when it was left in place. */
  backup: string | null;
}

/** Options for {@link migrateLegacyKeystore}. */
export interface LegacyMigrationOptions {
  /** Target keystore (its `ready` promise must already have resolved). */
  keystore: KeyStoreAPI;
  /** Explicit legacy file path; defaults to the one in {@link stateDir}. */
  file?: string;
  /** State directory holding the legacy file; defaults to the AC2 state dir. */
  stateDir?: string;
  /** Legacy AES master key; defaults to the OS-keychain entry. */
  masterKey?: Buffer | Uint8Array;
  /** OS-keychain service holding the legacy master key. */
  keychainService?: string;
  /** Progress sink. */
  log?: (line: string) => void;
}

/** Pick a backup path that does not clobber an earlier migration. */
function backupPathFor(file: string): string {
  const candidate = `${file}${LEGACY_BACKUP_SUFFIX}`;
  return existsSync(candidate) ? `${candidate}.${Date.now()}` : candidate;
}


/**
 * Translate a decrypted legacy record into the `KeyData` the upstream keystore
 * accepts, or `null` when the record holds nothing importable.
 */
function toImportable(id: string, data: KeyData): (Omit<KeyData, 'id'> & { id: string }) | null {
  const privateKey = data.privateKey;
  if (!(privateKey instanceof Uint8Array) || privateKey.length === 0) return null;
  const keyUsages = data.keyUsages;
  const metadata = data.metadata;
  if (
    data.type === 'ed25519' ||
    (data.type === undefined && (privateKey.length === 32 || privateKey.length === 64))
  ) {
    // The legacy engine persisted the libsodium-style 64-byte secret key
    // (seed ‖ public key); the upstream keystore takes the bare 32-byte seed.
    const seed = toEd25519Seed(privateKey);
    return {
      id,
      type: 'ed25519',
      algorithm: 'EdDSA',
      extractable: false,
      keyUsages: keyUsages ?? ['sign', 'verify'],
      privateKey: seed,
      ...(data.publicKey instanceof Uint8Array ? { publicKey: data.publicKey } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }
  if (data.type === 'seed' || data.type === 'hd-seed' || data.type === 'hd-root-key') {
    return {
      id,
      type: data.type === 'hd-seed' ? 'seed' : data.type,
      algorithm: 'raw',
      extractable: false,
      keyUsages: keyUsages ?? ['deriveBits', 'deriveKey'],
      privateKey,
      ...(metadata ? { metadata } : {}),
    };
  }
  return null;
}

/** True when `id` already exists in the target keystore. */
async function alreadyPresent(keystore: KeyStoreAPI, id: string): Promise<boolean> {
  try {
    await keystore.export(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lift a legacy `ac2-keystore.json` into `keystore`.
 *
 * @returns The migration outcome, or `null` when there is no legacy file (the
 *   normal case on a fresh install and on every start after the first).
 */
export async function migrateLegacyKeystore(
  options: LegacyMigrationOptions,
): Promise<LegacyMigrationResult | null> {
  const log = options.log ?? ((): void => {});
  const file =
    options.file ?? resolveLegacyKeystoreFile(resolveKeystoreStateDir(options.stateDir));
  const legacy = readLegacyKeystoreFile(file);
  if (!legacy) return null;

  const ids = Object.keys(legacy.keys);
  const migrated: string[] = [];
  const skipped: LegacyMigrationSkip[] = [];
  let failed = 0;

  let masterKey: Buffer | Uint8Array | null = options.masterKey ?? null;
  if (!masterKey && ids.length > 0) {
    try {
      masterKey = await readLegacyMasterKey(options.keychainService);
    } catch (err) {
      log(`[ac2] legacy keystore migration deferred: ${(err as Error).message}`);
      return { file, migrated, skipped: ids.map((id) => ({ id, reason: 'keychain unavailable' })), backup: null };
    }
    if (!masterKey) {
      log(
        `[ac2] found a legacy keystore at ${file} but its master key is gone; ` +
          'leaving the file in place.',
      );
      return { file, migrated, skipped: ids.map((id) => ({ id, reason: 'master key missing' })), backup: null };
    }
  }

  for (const id of ids) {
    const entry = legacy.keys[id];
    if (!entry?.secret) {
      skipped.push({ id, reason: 'no secret stored' });
      continue;
    }
    if (await alreadyPresent(options.keystore, id)) {
      skipped.push({ id, reason: 'already present' });
      continue;
    }
    try {
      const importable = toImportable(id, decryptLegacyEntry(masterKey as Buffer, entry.secret));
      if (!importable) {
        skipped.push({ id, reason: 'unsupported key type' });
        continue;
      }
      await options.keystore.import(importable);
      migrated.push(id);
    } catch (err) {
      failed += 1;
      skipped.push({ id, reason: (err as Error).message });
      log(`[ac2] failed to migrate legacy key ${id}: ${(err as Error).message}`);
    }
  }

  // Only retire the legacy file when nothing failed — a partial migration must
  // stay retryable. The file is preserved as a backup, never deleted.
  let backup: string | null = null;
  if (failed === 0) {
    try {
      backup = backupPathFor(file);
      renameSync(file, backup);
    } catch (err) {
      log(`[ac2] could not archive the legacy keystore: ${(err as Error).message}`);
      backup = null;
    }
  }

  if (migrated.length > 0) {
    log(
      `[ac2] migrated ${migrated.length} key(s) from the legacy keystore` +
        (backup ? ` (backup: ${backup})` : ''),
    );
  }
  return { file, migrated, skipped, backup };
}
