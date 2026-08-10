/**
 * Keystore capability the daemon hands ONLY to its BUILT-IN runtime adapters
 * — never to a loaded third-party adapter, and not part of the published
 * `@algorandfoundation/ac2-sdk/runtime` contract (same arrangement as
 * `SocketRuntimeHost` in `socket-adapter.ts`).
 *
 * WHY IT IS DELIBERATELY NARROW: the public `Ac2RuntimeHost` exposes the
 * daemon's identity as `serviceDid` — a STRING. Widening that to "here is a
 * signing oracle over the daemon's identity key" for every loadable adapter
 * package is not something an adapter seam should do. In-tree built-ins are a
 * different trust level: they ship with the daemon, so they may sign as the
 * service identity (the `openclaw-gateway` adapter does, to authenticate this
 * daemon as a device to the OpenClaw Gateway — see `gateway/device-identity.ts`).
 *
 * The implementation lives in `identity/service-key.ts`; this module only
 * declares the contract, so the identity layer and the runtime layer do not
 * import each other's internals.
 */

import type { Ac2RuntimeHost } from '@algorandfoundation/ac2-sdk/runtime';

/** Narrow, daemon-internal view of the AC2 keystore. */
export interface Ac2ServiceKeystoreAccess {
  /**
   * RAW Ed25519 public key (32 bytes) of the daemon's `ac2-service` key,
   * generating it on first use. This is the same key the daemon's `did:key`
   * is derived from.
   */
  servicePublicKey(): Promise<Uint8Array>;
  /**
   * Sign `data` with the `ac2-service` key; resolves the raw 64-byte Ed25519
   * signature. Rejects when the key is unavailable (locked keychain, failed
   * migration) — callers must treat that as "cannot authenticate right now",
   * never as a fatal error.
   */
  signWithServiceKey(data: Uint8Array): Promise<Uint8Array>;
  /**
   * Read an application-owned secret previously stored with
   * {@link writeSecret}; `undefined` when absent or when the keystore backend
   * has no secret store.
   */
  readSecret(id: string): Promise<string | undefined>;
  /** Store an application-owned secret, sealed at rest by the keystore. */
  writeSecret(id: string, value: string): Promise<void>;
}

/** {@link Ac2RuntimeHost} plus the daemon-internal keystore capability. */
export interface KeystoreRuntimeHost extends Ac2RuntimeHost {
  serviceKeystore: Ac2ServiceKeystoreAccess;
}

/** Narrow a generic host down to {@link KeystoreRuntimeHost}. */
export function isKeystoreRuntimeHost(host: Ac2RuntimeHost): host is KeystoreRuntimeHost {
  const access = (host as Partial<KeystoreRuntimeHost>).serviceKeystore;
  return (
    typeof access === 'object' &&
    access !== null &&
    typeof access.servicePublicKey === 'function' &&
    typeof access.signWithServiceKey === 'function'
  );
}
