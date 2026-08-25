/**
 * A real Ed25519 keypair for a fake wallet to grant as the agent identity.
 *
 * The daemon hard-fails a session whose wallet-issued identity key cannot be
 * persisted (`recordIdentityKey` throws instead of best-effort logging), and
 * the keystore only accepts genuine 32-byte Ed25519 material — so a fixture
 * that grants a stub string would kill the session before
 * `connection.connected` ever fires.
 */

import { generateKeyPairSync } from 'node:crypto';

export interface AgentKeyMaterial {
  /** Base64 32-byte Ed25519 seed, exactly as a wallet sends it. */
  material: string;
  /** Base64 32-byte Ed25519 public key matching {@link material}. */
  publicKey: string;
}

/** Generate a fresh, valid wallet-grantable Ed25519 identity keypair. */
export function generateAgentKeyMaterial(): AgentKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    material: Buffer.from(pkcs8.subarray(pkcs8.length - 32)).toString('base64'),
    publicKey: Buffer.from(spki.subarray(spki.length - 32)).toString('base64'),
  };
}
