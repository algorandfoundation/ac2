/**
 * Keystore file backend. Each entry stores public `meta` (plain) and `secret`
 * (AES-256-GCM encrypted under the master key from {@link getMasterKey}).
 *
 * Every write is best-effort but synchronous, so a `commit` is durable by the
 * time it returns — this is the "watch for changes and save to the file"
 * persistence the base `@algorandfoundation/keystore` reactive store lacks.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Key, KeyData } from '@algorandfoundation/keystore';
import { DEFAULT_KEYSTORE_FILE } from '../constants.js';
import { DecodingError, EncodingError } from '../errors.js';
import type { AuthenticationOptions, NodeKeyStoreOptions } from '../types.js';
import { decryptData, encryptData, getMasterKey } from './crypto.js';

/** A single persisted keystore entry. */
interface StoredEntry {
  /** Public key metadata (no private material). */
  meta: unknown;
  /** AES-256-GCM encrypted, JSON-encoded full {@link KeyData}. */
  secret: string;
}

/** On-disk file shape. */
interface KeystoreFile {
  version: 1;
  keys: Record<string, StoredEntry>;
}

/** Resolve the absolute keystore file path from options / environment. */
export function resolveKeystoreFile(options?: NodeKeyStoreOptions): string {
  const stateDir =
    options?.stateDir ?? process.env['OPENCLAW_STATE_DIR']?.trim() ?? join(homedir(), '.openclaw');
  return join(stateDir, options?.fileName ?? DEFAULT_KEYSTORE_FILE);
}

function readFile(file: string): KeystoreFile {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as KeystoreFile;
    if (parsed && typeof parsed === 'object' && parsed.keys) return parsed;
  } catch {
    // Missing / unreadable / corrupt — start fresh.
  }
  return { version: 1, keys: {} };
}

function writeFile(file: string, data: KeystoreFile): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Persistence is best-effort; never throw into the caller's flow.
  }
}

/** JSON replacer that turns `Uint8Array`/`Buffer` into plain number arrays. */
function bytesReplacer(_key: string, value: unknown): unknown {
  if (
    value instanceof Uint8Array ||
    (value != null &&
      typeof value === 'object' &&
      (value as { constructor?: { name?: string } }).constructor?.name === 'Uint8Array')
  ) {
    return Array.from(value as Uint8Array);
  }
  return value;
}

/** JSON reviver that turns key-material number arrays back into `Uint8Array`. */
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

/** Serialize a {@link KeyData} to a JSON string (bytes → arrays). */
export function encode(key: KeyData): string {
  try {
    return JSON.stringify(key, bytesReplacer);
  } catch (err) {
    throw new EncodingError('Failed to encode key for storage', err);
  }
}

/** Parse a JSON string produced by {@link encode} back to a {@link KeyData}. */
export function decode(data: string): KeyData {
  try {
    return JSON.parse(data, bytesReviver) as KeyData;
  } catch (err) {
    throw new DecodingError('Failed to decode stored key', err);
  }
}

/** Strip private material from a {@link KeyData}, leaving public {@link Key} metadata. */
function toMeta(key: KeyData): Key {
  const { privateKey: _privateKey, ...rest } = key as KeyData & { seed?: unknown };
  delete (rest as { seed?: unknown }).seed;
  return rest as Key;
}

/**
 * Persist a key: encrypt the full {@link KeyData} under the master key and
 * record its public metadata. Returns the public metadata stored.
 */
export async function commit({
  file,
  keyData,
  options,
}: {
  file: string;
  keyData: KeyData;
  options?: AuthenticationOptions;
}): Promise<Key> {
  if (typeof keyData.id === 'undefined') {
    throw new EncodingError('KeyData must have an id before committing to storage');
  }
  const masterKey = await getMasterKey(options);
  const secret = encryptData(masterKey, encode(keyData));
  const meta = toMeta(keyData);
  const current = readFile(file);
  current.keys[keyData.id] = { meta: JSON.parse(JSON.stringify(meta, bytesReplacer)), secret };
  writeFile(file, current);
  return meta;
}

/** Fetch and decrypt the full {@link KeyData} for `keyId`, or null if absent. */
export async function fetchSecret({
  file,
  keyId,
  options,
}: {
  file: string;
  keyId: string;
  options?: AuthenticationOptions;
}): Promise<KeyData | null> {
  const entry = readFile(file).keys[keyId];
  if (!entry) return null;
  const masterKey = await getMasterKey(options);
  return decode(decryptData(masterKey, entry.secret));
}

/** Remove a persisted key (best-effort). */
export function removeSecret({ file, keyId }: { file: string; keyId: string }): void {
  const current = readFile(file);
  if (current.keys[keyId]) {
    delete current.keys[keyId];
    writeFile(file, current);
  }
}

/** Clear every persisted key. */
export function clearAll(file: string): void {
  writeFile(file, { version: 1, keys: {} });
}

/** List the public metadata of every persisted key (for rehydrating the store). */
export function listMeta(file: string): Key[] {
  const { keys } = readFile(file);
  return Object.values(keys).map(
    (entry) => JSON.parse(JSON.stringify(entry.meta), bytesReviver) as Key,
  );
}
