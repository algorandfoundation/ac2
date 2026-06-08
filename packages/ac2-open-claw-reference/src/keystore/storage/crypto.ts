/** AES-256-GCM secret wrapping under a master key held in the OS keychain. */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DEFAULT_KEYCHAIN_SERVICE, MASTER_KEY_ACCOUNT } from '../constants.js';
import { UnlockingError } from '../errors.js';
import type { AuthenticationOptions } from '../types.js';

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

function toBuffer(key: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(key) ? key : Buffer.from(key);
}

/**
 * Dynamically load `@napi-rs/keyring`'s `Entry`. Imported lazily so a missing
 * native binary degrades to a thrown {@link UnlockingError} at call time rather
 * than crashing module evaluation (the keystore should still *load* even where
 * the native addon is unavailable).
 */
async function keychainEntry(service: string): Promise<{
  getPassword: () => string | null;
  setPassword: (password: string) => void;
  deletePassword: () => boolean;
}> {
  const mod = (await import('@napi-rs/keyring')) as {
    Entry: new (
      service: string,
      account: string,
    ) => {
      getPassword: () => string | null;
      setPassword: (password: string) => void;
      deletePassword: () => boolean;
    };
  };
  return new mod.Entry(service, MASTER_KEY_ACCOUNT);
}

/**
 * Retrieve the AES master key from the OS keychain, generating and persisting a
 * fresh 32-byte key on first use. An explicit `options.masterKey` short-circuits
 * the keychain entirely.
 */
export async function getMasterKey(options?: AuthenticationOptions): Promise<Buffer> {
  if (options?.masterKey) return toBuffer(options.masterKey);
  const service = options?.service ?? DEFAULT_KEYCHAIN_SERVICE;
  let entry: Awaited<ReturnType<typeof keychainEntry>>;
  try {
    entry = await keychainEntry(service);
  } catch (err) {
    throw new UnlockingError(
      'OS keychain backend (@napi-rs/keyring) is unavailable; cannot resolve the master key.',
      err,
    );
  }
  // `getPassword` returns null (or throws "not found") when no entry exists.
  let existing: string | null = null;
  try {
    existing = entry.getPassword();
  } catch {
    existing = null;
  }
  if (existing) return Buffer.from(existing, 'hex');
  const newKey = randomBytes(32);
  entry.setPassword(newKey.toString('hex'));
  return Buffer.from(newKey);
}

/** Remove the master key from the OS keychain (best-effort). */
export async function clearMasterKey(options?: AuthenticationOptions): Promise<void> {
  if (options?.masterKey) return;
  const service = options?.service ?? DEFAULT_KEYCHAIN_SERVICE;
  try {
    const entry = await keychainEntry(service);
    entry.deletePassword();
  } catch {
    // Best-effort: a missing entry / backend is not an error on clear.
  }
}

/** Encrypt `data` with AES-256-GCM under `key`, returning a JSON payload string. */
export function encryptData(key: Buffer, data: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(data, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();
  const payload: EncryptedPayload = {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    content: encrypted,
  };
  return JSON.stringify(payload);
}

/** Decrypt a JSON payload produced by {@link encryptData}. */
export function decryptData(key: Buffer, payloadStr: string): string {
  const { iv, tag, content } = JSON.parse(payloadStr) as EncryptedPayload;
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  let decrypted = decipher.update(content, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
