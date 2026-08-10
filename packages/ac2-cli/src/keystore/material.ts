/** Normalization of Ed25519 secret material handed to the keystore. */

/**
 * Reduce Ed25519 secret material to the 32-byte seed the keystore imports.
 *
 * Wallets (and the AC2 storage engine that preceded the upstream keystore) hand
 * out the libsodium-style 64-byte secret key — the seed followed by the public
 * key — while some send the bare seed. Both are accepted here; anything else is
 * rejected rather than silently truncated.
 */
export function toEd25519Seed(secret: Uint8Array): Uint8Array {
  if (secret.length === 32) return secret;
  if (secret.length === 64) return secret.subarray(0, 32);
  throw new Error(
    `Unsupported Ed25519 secret length ${secret.length}: expected 32 (seed) or 64 (seed ‖ public key)`,
  );
}

/** Decode base64 secret material into its 32-byte Ed25519 seed. */
export function ed25519SeedFromBase64(material: string): Uint8Array {
  return toEd25519Seed(new Uint8Array(Buffer.from(material, 'base64')));
}
