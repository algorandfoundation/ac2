/**
 * Tests for the one-time migration of the pre-upstream AC2 keystore
 * (`ac2-keystore.json`, AES-256-GCM under an OS-keychain master key) into the
 * upstream keystore engine.
 *
 * The legacy writer is reproduced here (that code is gone from `src/`) so the
 * fixtures are byte-compatible with what shipped, and the keystore itself runs
 * against in-memory keychain/metadata seams.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCipheriv, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LEGACY_KEYSTORE_FILE, migrateLegacyKeystore } from '../src/keystore/index.js';
import { createKeyStoreFixture } from './helpers/keystore.js';

/** Fixed legacy master key, so the OS keychain is never consulted. */
const MASTER_KEY = Buffer.alloc(32, 7);

/** A real Ed25519 keypair: 32-byte seed + 32-byte public key. */
function ed25519Fixture(): { seed: Uint8Array; publicKey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    seed: new Uint8Array(pkcs8.subarray(pkcs8.length - 32)),
    publicKey: new Uint8Array(spki.subarray(spki.length - 32)),
  };
}

/** The legacy AES-256-GCM envelope (`{ iv, tag, content }`, all base64). */
function encryptLegacy(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  let content = cipher.update(plaintext, 'utf8', 'base64');
  content += cipher.final('base64');
  return JSON.stringify({
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    content,
  });
}

/** Legacy byte encoding: `Uint8Array` fields were persisted as number arrays. */
function encodeLegacyKey(key: Record<string, unknown>): string {
  return JSON.stringify(key, (_k, value) =>
    value instanceof Uint8Array ? Array.from(value) : value,
  );
}

/** Write a legacy keystore file holding `keys`. */
async function writeLegacyFile(
  file: string,
  keys: Record<string, Record<string, unknown>>,
): Promise<void> {
  const entries: Record<string, { meta: unknown; secret: string }> = {};
  for (const [id, keyData] of Object.entries(keys)) {
    const { privateKey: _private, ...meta } = keyData;
    entries[id] = {
      meta: JSON.parse(encodeLegacyKey(meta)),
      secret: encryptLegacy(encodeLegacyKey(keyData)),
    };
  }
  await writeFile(file, JSON.stringify({ version: 1, keys: entries }, null, 2), 'utf-8');
}

describe('migrateLegacyKeystore', () => {
  let stateDir: string;
  let file: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'ac2-keystore-migrate-'));
    file = join(stateDir, LEGACY_KEYSTORE_FILE);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('returns null when there is nothing to migrate', async () => {
    const keystore = createKeyStoreFixture(stateDir).create();
    await keystore.ready;
    expect(await migrateLegacyKeystore({ keystore: keystore.keystore, stateDir })).toBeNull();
  });

  it('lifts an ed25519 key under the same id, keeping its public key and signing ability', async () => {
    const { seed, publicKey } = ed25519Fixture();
    await writeLegacyFile(file, {
      'ac2-service': {
        id: 'ac2-service',
        type: 'ed25519',
        algorithm: 'EdDSA',
        extractable: true,
        publicKey,
        privateKey: seed,
      },
    });

    const keystore = createKeyStoreFixture(stateDir).create();
    await keystore.ready;
    const result = await migrateLegacyKeystore({
      keystore: keystore.keystore,
      stateDir,
      masterKey: MASTER_KEY,
    });

    expect(result?.migrated).toEqual(['ac2-service']);
    const meta = keystore.keys.find((key) => key.id === 'ac2-service');
    expect(meta?.type).toBe('ed25519');
    expect(Buffer.from(meta?.publicKey ?? new Uint8Array()).toString('base64')).toBe(
      Buffer.from(publicKey).toString('base64'),
    );

    // The migrated key still owns its private material: it signs, and the
    // signature verifies against the ORIGINAL public key — i.e. the DID derived
    // from it is unchanged.
    const data = Buffer.from('migrated payload');
    const signature = await keystore.keystore.sign('ac2-service', new Uint8Array(data));
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(publicKey),
    ]);
    expect(
      verify(null, data, { key: spki, format: 'der', type: 'spki' }, Buffer.from(signature)),
    ).toBe(true);
  });

  it('accepts the 64-byte `seed ‖ publicKey` secret the legacy engine actually wrote', async () => {
    const { seed, publicKey } = ed25519Fixture();
    const secretKey = new Uint8Array(64);
    secretKey.set(seed, 0);
    secretKey.set(publicKey, 32);
    await writeLegacyFile(file, {
      'ac2-service': {
        id: 'ac2-service',
        type: 'ed25519',
        name: 'AC2 service identity',
        algorithm: 'EdDSA',
        format: 'raw',
        extractable: true,
        keyUsages: ['sign', 'verify'],
        publicKey,
        privateKey: secretKey,
      },
    });

    const keystore = createKeyStoreFixture(stateDir).create();
    await keystore.ready;
    const result = await migrateLegacyKeystore({
      keystore: keystore.keystore,
      stateDir,
      masterKey: MASTER_KEY,
    });

    expect(result?.migrated).toEqual(['ac2-service']);
    const data = Buffer.from('64-byte legacy secret');
    const signature = await keystore.keystore.sign('ac2-service', new Uint8Array(data));
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(publicKey),
    ]);
    expect(
      verify(null, data, { key: spki, format: 'der', type: 'spki' }, Buffer.from(signature)),
    ).toBe(true);
  });

  it('archives the legacy file as a .migrated backup instead of deleting it', async () => {
    const { seed, publicKey } = ed25519Fixture();
    await writeLegacyFile(file, {
      'did:key:zAgent': {
        id: 'did:key:zAgent',
        type: 'ed25519',
        algorithm: 'EdDSA',
        extractable: true,
        publicKey,
        privateKey: seed,
      },
    });
    const before = await readFile(file, 'utf-8');

    const keystore = createKeyStoreFixture(stateDir).create();
    await keystore.ready;
    const result = await migrateLegacyKeystore({
      keystore: keystore.keystore,
      stateDir,
      masterKey: MASTER_KEY,
    });

    expect(result?.backup).toBe(`${file}.migrated`);
    expect(existsSync(file)).toBe(false);
    expect(await readFile(`${file}.migrated`, 'utf-8')).toBe(before);
  });

  it('is idempotent: a key already in the keystore is skipped, not re-imported', async () => {
    const { seed, publicKey } = ed25519Fixture();
    const entry = {
      id: 'ac2-service',
      type: 'ed25519',
      algorithm: 'EdDSA',
      extractable: true,
      publicKey,
      privateKey: seed,
    };
    await writeLegacyFile(file, { 'ac2-service': entry });

    const fixture = createKeyStoreFixture(stateDir);
    const keystore = fixture.create();
    await keystore.ready;
    await migrateLegacyKeystore({ keystore: keystore.keystore, stateDir, masterKey: MASTER_KEY });

    // Same machine (shared keyring/metadata), legacy file restored: a second
    // pass must leave the stored key alone.
    await writeLegacyFile(file, { 'ac2-service': entry });
    const second = fixture.create();
    await second.ready;
    const result = await migrateLegacyKeystore({
      keystore: second.keystore,
      stateDir,
      masterKey: MASTER_KEY,
    });

    expect(result?.migrated).toEqual([]);
    expect(result?.skipped).toEqual([{ id: 'ac2-service', reason: 'already present' }]);
    expect(second.keys.filter((key) => key.id === 'ac2-service')).toHaveLength(1);
  });

  it('skips entries it cannot represent, and still archives the file', async () => {
    await writeLegacyFile(file, {
      weird: {
        id: 'weird',
        type: 'rsa',
        algorithm: 'RS256',
        extractable: true,
        privateKey: new Uint8Array([1, 2, 3]),
      },
    });

    const keystore = createKeyStoreFixture(stateDir).create();
    await keystore.ready;
    const result = await migrateLegacyKeystore({
      keystore: keystore.keystore,
      stateDir,
      masterKey: MASTER_KEY,
    });

    expect(result?.migrated).toEqual([]);
    expect(result?.skipped).toEqual([{ id: 'weird', reason: 'unsupported key type' }]);
    expect(result?.backup).toBe(`${file}.migrated`);
  });

  it('createAc2KeyStore runs the migration as part of `ready`', async () => {
    const { seed, publicKey } = ed25519Fixture();
    await writeLegacyFile(file, {
      'ac2-service': {
        id: 'ac2-service',
        type: 'ed25519',
        algorithm: 'EdDSA',
        extractable: true,
        publicKey,
        privateKey: seed,
      },
    });

    const keystore = createKeyStoreFixture(stateDir).create({
      migrateLegacy: true,
      legacyMasterKey: MASTER_KEY,
    });
    await keystore.ready;

    expect(keystore.keys.map((key) => key.id)).toContain('ac2-service');
    expect(existsSync(file)).toBe(false);
  });
});
