/**
 * Device identity for the OpenClaw Gateway handshake, backed by the daemon's
 * OWN service key (`ac2-service` in the AC2 keystore).
 *
 * WHY A DEVICE IDENTITY IS NEEDED: the Gateway grants a connection its
 * operator scopes from the *identity* behind the connection, not from the
 * scopes the client asks for. A connect that carries only a shared
 * `auth.token` — no `device` block — is treated as UNBOUND: recent gateways
 * still answer `hello-ok` (an operator with valid shared auth may skip device
 * identity), but they first wipe the requested scopes, so the session ends up
 * with none and every subsequent RPC fails with `missing scope:
 * operator.read` / `missing scope: operator.write` even though the handshake
 * "succeeded".
 *
 * WHY THE SERVICE KEY: `ac2-service` is the daemon's one self-generated
 * Ed25519 key — the identity it already asserts as *itself* (it is what the
 * daemon's `did:key` is derived from), as opposed to the wallet-issued agent
 * identities the keystore also holds. Authenticating this daemon to the
 * Gateway is exactly that: an assertion of who the daemon is. So there is no
 * second key and no key file — the keystore keeps the private material
 * non-extractable and this module only ever asks it for a signature.
 *
 * The wire contract mirrored here (`v3` payload, base64url raw Ed25519 key
 * material, `deviceId` = SHA-256 of the raw public key) is the Gateway's own —
 * it re-derives the device id from `device.publicKey` and rejects a mismatch,
 * so none of these details are free choices. The signature covers a challenge
 * nonce the server pushes as a `connect.challenge` event, so the connect frame
 * can only be assembled AFTER that event arrives (see `client.ts`).
 */

import { createHash } from 'node:crypto';
import type { Ac2ServiceKeystoreAccess } from '../keystore-host.js';

/**
 * A signer the Gateway handshake can authenticate as. Both members are async
 * because the underlying key lives in the OS keychain behind the AC2 keystore.
 */
export interface GatewayDeviceIdentity {
  /** RAW Ed25519 public key bytes (32) — the `device.publicKey` material. */
  publicKeyRaw(): Promise<Uint8Array>;
  /** Raw 64-byte Ed25519 signature over `data`. */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/**
 * Present the daemon's service key as a Gateway device identity. Nothing is
 * touched eagerly: the key is only materialized when a handshake actually
 * needs it.
 */
export function createServiceKeyDeviceIdentity(
  keystore: Ac2ServiceKeystoreAccess,
): GatewayDeviceIdentity {
  return {
    publicKeyRaw: () => keystore.servicePublicKey(),
    sign: (data) => keystore.signWithServiceKey(data),
  };
}

/** Bytes → base64url, matching the Gateway's own encoding (no padding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

/** The Gateway's stable device id: SHA-256 (hex) over the RAW public key. */
export function deviceIdFromPublicKeyRaw(publicKeyRaw: Uint8Array): string {
  return createHash('sha256').update(publicKeyRaw).digest('hex');
}

/**
 * Keystore secret id under which the Gateway-issued device token for `role`
 * is kept. A device token is an opaque bearer credential, not key material,
 * so it goes in the keystore's SECRET store (sealed at rest, readable back)
 * rather than next to the keys.
 */
export function gatewayDeviceTokenSecretId(role: string): string {
  return `ac2-gateway-device-token:${role}`;
}

/** Everything the `v3` device-auth payload is built from. */
export interface DeviceAuthPayloadParams {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  /** The shared/bootstrap/device token also sent in `auth`, or `null`. */
  token: string | null;
  /** Nonce from the Gateway's `connect.challenge` event. */
  nonce: string;
  platform: string;
  deviceFamily?: string | undefined;
}

/** Trim + lowercase, exactly as the Gateway normalizes device metadata. */
function normalizeMetadata(value: string | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Build the `v3` device-auth payload string the Gateway verifies the device
 * signature against. Field order and separator are part of the wire contract.
 */
export function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadParams): string {
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token ?? '',
    params.nonce,
    normalizeMetadata(params.platform),
    normalizeMetadata(params.deviceFamily),
  ].join('|');
}

/** The `device` object of a `connect` request. */
export interface DeviceConnectParams {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
}

/**
 * Assemble (and sign) the `device` block of a `connect` request. The signature
 * commits to the requested `scopes`, so the Gateway can bind exactly those
 * scopes to this device instead of discarding them.
 *
 * Rejects when the service key cannot be read or used — the caller decides
 * whether to connect unsigned or give up (see `client.ts`).
 */
export async function buildDeviceConnectParams(opts: {
  identity: GatewayDeviceIdentity;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  /** Token sent in `auth` (shared token wins, then device token); `null` if none. */
  signatureToken: string | null;
  nonce: string;
  platform: string;
  signedAtMs?: number;
}): Promise<DeviceConnectParams> {
  const publicKeyRaw = await opts.identity.publicKeyRaw();
  const deviceId = deviceIdFromPublicKeyRaw(publicKeyRaw);
  const signedAtMs = opts.signedAtMs ?? Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId,
    clientId: opts.clientId,
    clientMode: opts.clientMode,
    role: opts.role,
    scopes: opts.scopes,
    signedAtMs,
    token: opts.signatureToken,
    nonce: opts.nonce,
    platform: opts.platform,
  });
  const signature = await opts.identity.sign(Buffer.from(payload, 'utf8'));
  return {
    id: deviceId,
    publicKey: base64UrlEncode(publicKeyRaw),
    signature: base64UrlEncode(signature),
    signedAt: signedAtMs,
    nonce: opts.nonce,
  };
}
