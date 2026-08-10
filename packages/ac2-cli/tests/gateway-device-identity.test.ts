/**
 * Tests for `src/runtime/gateway/device-identity.ts` — the Gateway handshake
 * signed with the daemon's OWN service key (`ac2-service`). The wire details
 * asserted here (device id derivation, base64url key/signature encoding, the
 * `v3` payload layout) are the Gateway's contract, not ours: it re-derives the
 * id from the public key and verifies the signature against the same string.
 *
 * These run against the REAL keystore engine over in-memory seams (see
 * `helpers/keystore.ts`), so what is exercised is the actual
 * non-extractable-key signing path the daemon uses — not a stand-in.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { SERVICE_KEY_ID } from '../src/keystore/index.js';
import { createServiceKeystoreAccess, ensureServiceKey } from '../src/identity/service-key.js';
import { createKeyStoreFixture, type KeyStoreFixture } from './helpers/keystore.js';
import {
  buildDeviceAuthPayloadV3,
  buildDeviceConnectParams,
  createServiceKeyDeviceIdentity,
  deviceIdFromPublicKeyRaw,
  gatewayDeviceTokenSecretId,
} from '../src/runtime/gateway/device-identity.js';

/** DER prefix of an Ed25519 SPKI key, so a raw public key can be verified with. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFromRaw(raw: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

describe('gateway device identity (service key)', () => {
  let fixture: KeyStoreFixture;

  beforeEach(() => {
    fixture = createKeyStoreFixture();
  });

  it('generates the service key once and reuses it on every later call', async () => {
    const store = fixture.create();
    const first = await ensureServiceKey(store);
    const second = await ensureServiceKey(store);
    expect(Buffer.from(second)).toEqual(Buffer.from(first));
    expect(first).toHaveLength(32);
    expect(store.keys.filter((key) => key.id === SERVICE_KEY_ID)).toHaveLength(1);
  });

  it('survives a restart: a second keystore finds the same service key', async () => {
    const first = await ensureServiceKey(fixture.create());
    // Same keyring + metadata, fresh engine — i.e. the daemon restarting.
    const second = await ensureServiceKey(fixture.create());
    expect(Buffer.from(second)).toEqual(Buffer.from(first));
  });

  it('derives the device id as SHA-256 over the RAW public key', async () => {
    const keystore = createServiceKeystoreAccess(fixture.create());
    const raw = await keystore.servicePublicKey();
    expect(deviceIdFromPublicKeyRaw(raw)).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(deviceIdFromPublicKeyRaw(raw)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs a connect payload the gateway can verify against the service public key', async () => {
    const keystore = createServiceKeystoreAccess(fixture.create());
    const publicKeyRaw = await keystore.servicePublicKey();
    const deviceId = deviceIdFromPublicKeyRaw(publicKeyRaw);

    const device = await buildDeviceConnectParams({
      identity: createServiceKeyDeviceIdentity(keystore),
      clientId: 'cli',
      clientMode: 'cli',
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      signatureToken: 'shared-token',
      nonce: 'nonce-abc',
      platform: 'Darwin',
      signedAtMs: 1_700_000_000_000,
    });

    expect(device).toMatchObject({
      id: deviceId,
      publicKey: Buffer.from(publicKeyRaw).toString('base64url'),
      signedAt: 1_700_000_000_000,
      nonce: 'nonce-abc',
    });

    const payload = buildDeviceAuthPayloadV3({
      deviceId,
      clientId: 'cli',
      clientMode: 'cli',
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      signedAtMs: 1_700_000_000_000,
      token: 'shared-token',
      nonce: 'nonce-abc',
      platform: 'Darwin',
    });
    // Platform is normalized (trimmed + lowercased) and an absent device
    // family is an EMPTY trailing field — both are part of the contract.
    expect(payload).toBe(
      'v3|' +
        deviceId +
        '|cli|cli|operator|operator.read,operator.write|1700000000000|shared-token|nonce-abc|darwin|',
    );
    expect(
      verify(
        null,
        Buffer.from(payload, 'utf8'),
        publicKeyFromRaw(publicKeyRaw),
        Buffer.from(device.signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('round-trips an issued device token through the keystore secret store', async () => {
    const keystore = createServiceKeystoreAccess(fixture.create());
    const id = gatewayDeviceTokenSecretId('operator');
    expect(id).toBe('ac2-gateway-device-token:operator');
    expect(await keystore.readSecret(id)).toBeUndefined();
    await keystore.writeSecret(id, 'dt-1');
    expect(await keystore.readSecret(id)).toBe('dt-1');
    // Re-issuing overwrites rather than failing on the existing id.
    await keystore.writeSecret(id, 'dt-2');
    expect(await keystore.readSecret(id)).toBe('dt-2');
  });

  it('keeps the device token out of the key material', async () => {
    const store = fixture.create();
    const keystore = createServiceKeystoreAccess(store);
    await keystore.servicePublicKey();
    await keystore.writeSecret(gatewayDeviceTokenSecretId('operator'), 'dt-1');
    // The service key is untouched by secret writes, and stays signable.
    const publicKeyRaw = await keystore.servicePublicKey();
    const signature = await keystore.signWithServiceKey(Buffer.from('probe', 'utf8'));
    expect(
      verify(null, Buffer.from('probe', 'utf8'), publicKeyFromRaw(publicKeyRaw), signature),
    ).toBe(true);
  });
});
