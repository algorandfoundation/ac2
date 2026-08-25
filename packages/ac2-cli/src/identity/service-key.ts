/**
 * The daemon's OWN service key (`ac2-service`) — the one self-generated
 * Ed25519 key in the AC2 keystore that is not wallet-issued.
 *
 * It backs the daemon's `did:key` (see `daemon/broker.ts`), and it is the key
 * the daemon signs *as itself* with: everything else in the keystore is either
 * an identity the wallet granted to an agent or an opaque secret. Because the
 * key is non-extractable, callers never see private material — they sign
 * through {@link Ac2ServiceKeystoreAccess.signWithServiceKey}.
 *
 * This module is also the single place that KNOWS how to materialize the key,
 * so the broker and the runtime host cannot drift into two subtly different
 * "generate the service key" code paths.
 */

import { SERVICE_KEY_ID, type Ac2KeyStore } from '../keystore/index.js';
import type { Ac2ServiceKeystoreAccess } from '../runtime/keystore-host.js';

/**
 * Ensure the `ac2-service` key exists and return its RAW Ed25519 public key
 * (32 bytes). Generating it is idempotent: `store.ready` also settles the
 * one-time migration of the pre-upstream keystore, so a service key carried
 * over from it is found instead of regenerated.
 *
 * @throws when the key exists but exposes no public key (a broken keystore).
 */
export async function ensureServiceKey(store: Ac2KeyStore): Promise<Uint8Array> {
  await store.ready;
  let publicKey = store.keys.find((key) => key.id === SERVICE_KEY_ID)?.publicKey;
  if (!publicKey) {
    await store.keystore.generate({
      type: 'ed25519',
      algorithm: 'EdDSA',
      extractable: false,
      keyUsages: ['sign', 'verify'],
      params: { id: SERVICE_KEY_ID, name: 'AC2 service identity' },
    });
    publicKey = (await store.keystore.export(SERVICE_KEY_ID)).publicKey;
  }
  if (!publicKey) {
    throw new Error('[ac2] service key exists but exposes no public key');
  }
  return publicKey;
}

/**
 * Build the keystore capability the daemon hands to its BUILT-IN runtime
 * adapters (see `runtime/keystore-host.ts`). The public key is resolved once
 * and cached; signing goes straight to the keystore every time, so a key
 * rotation or a locked keychain surfaces as a failed signature rather than a
 * stale success.
 */
export function createServiceKeystoreAccess(store: Ac2KeyStore): Ac2ServiceKeystoreAccess {
  let publicKey: Promise<Uint8Array> | undefined;
  return {
    servicePublicKey(): Promise<Uint8Array> {
      publicKey ??= ensureServiceKey(store).catch((err: unknown) => {
        // Don't cache a failure: a later attempt (keychain unlocked, migration
        // finished) should be able to succeed.
        publicKey = undefined;
        throw err;
      });
      return publicKey;
    },
    async signWithServiceKey(data: Uint8Array): Promise<Uint8Array> {
      await store.ready;
      return store.keystore.sign(SERVICE_KEY_ID, data);
    },
    async readSecret(id: string): Promise<string | undefined> {
      const secrets = store.keystore.secrets;
      if (!secrets) return undefined;
      try {
        await store.ready;
        return Buffer.from(await secrets.get(id)).toString('utf-8');
      } catch {
        // Absent (the normal first-run case) or unreadable — both mean "no value".
        return undefined;
      }
    },
    async writeSecret(id: string, value: string): Promise<void> {
      const secrets = store.keystore.secrets;
      if (!secrets) return;
      await store.ready;
      // `put` with an explicit id overwrites; remove first so a backend that
      // rejects a duplicate id still ends up with the new value.
      try {
        await secrets.remove(id);
      } catch {
        // nothing stored yet
      }
      await secrets.put(value, { id, name: 'AC2 gateway device token' });
    },
  };
}
