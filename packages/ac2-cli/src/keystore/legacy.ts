/**
 * Reader for the pre-migration keystore: an `ac2-keystore.json` file whose
 * entries hold AES-256-GCM encrypted key data, wrapped under a master key kept
 * in the OS keychain.
 *
 * This module exists **only** so {@link migrateLegacyKeystore} can lift that
 * data into the upstream keystore — AC2 no longer runs a storage engine of its
 * own. It is intentionally read-only: nothing here ever writes key material.
 */

import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { KeyData } from '@algorandfoundation/keystore-node';
import { LEGACY_KEYCHAIN_SERVICE, LEGACY_MASTER_KEY_ACCOUNT } from './constants.js';
import { DecodingError, UnlockingError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';

/** Shape of an AES-256-GCM payload persisted as a JSON string. */
interface EncryptedPayload {
  /** Base64 12-byte IV. */
  iv: string;
  /** Base64 GCM auth tag. */
  tag: string;
  /** Base64 ciphertext. */
  content: string;
}

/** A single entry of the legacy on-disk file. */
interface LegacyEntry {
  /** Public key metadata (no private material). */
  meta?: unknown;
  /** AES-256-GCM encrypted, JSON-encoded full key data. */
  secret: string;
}

/** Legacy on-disk file shape. */
interface LegacyFile {
  version?: number;
  keys: Record<string, LegacyEntry>;
}

/**
 * JSON reviver that turns key-material number arrays back into `Uint8Array`,
 * mirroring the replacer the legacy writer used.
 */
function bytesReviver(key: string, value: unknown): unknown {
  if (
    (key.endsWith('Key') ||
      key === 'privateKey' ||
      key === 'publicKey' ||
      key === 'seed' ||
      key === 'key') &&
    Array.isArray(value)
  ) {
    return new Uint8Array(value as number[]);
  }
  return value;
}

/**
 * Read the legacy AES master key from the OS keychain. Unlike the writer this
 * replaced, it never *creates* a key: a missing entry means there is nothing to
 * migrate.
 */
export async function readLegacyMasterKey(service = LEGACY_KEYCHAIN_SERVICE): Promise<Buffer | null> {
  let entry: { getPassword: () => string | null };
  try {
    const mod = (await import('@napi-rs/keyring')) as {
      Entry: new (service: string, account: string) => { getPassword: () => string | null };
    };
    entry = new mod.Entry(service, LEGACY_MASTER_KEY_ACCOUNT);
  } catch (err) {
    throw new UnlockingError(
      'OS keychain backend (@napi-rs/keyring) is unavailable; cannot read the legacy master key.',
      err,
    );
  }
  try {
    const existing = entry.getPassword();
    return existing ? Buffer.from(existing, 'hex') : null;
  } catch {
    // `@napi-rs/keyring` throws when no entry exists; treat that as absent.
    return null;
  }
}

/** Decrypt one legacy `secret` blob into the key data it was encoded from. */
export function decryptLegacyEntry(masterKey: Buffer | Uint8Array, secret: string): KeyData {
  try {
    const { iv, tag, content } = JSON.parse(secret) as EncryptedPayload;
    const decipher = createDecipheriv(
      ALGORITHM,
      Buffer.isBuffer(masterKey) ? masterKey : Buffer.from(masterKey),
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    let decrypted = decipher.update(content, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted, bytesReviver) as KeyData;
  } catch (err) {
    throw new DecodingError('Failed to decrypt a legacy keystore entry', err);
  }
}

/**
 * Parse a legacy keystore file. Returns `null` when the file is absent,
 * unreadable or not a legacy keystore — all of which simply mean "nothing to
 * migrate".
 */
export function readLegacyKeystoreFile(file: string): LegacyFile | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as LegacyFile;
    if (parsed && typeof parsed === 'object' && parsed.keys && typeof parsed.keys === 'object') {
      return parsed;
    }
  } catch {
    // Missing / unreadable / corrupt — nothing to migrate.
  }
  return null;
}
