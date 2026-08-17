/**
 * SSHSIG (OpenSSH `PROTOCOL.sshsig`) encoding for Ed25519 keys and
 * signatures. This is the format `git` produces/consumes when
 * `gpg.format = ssh`, and the format git hosting providers verify for SSH
 * signing keys.
 *
 * The crucial property exploited by the AC2 git-signing flow: an SSHSIG
 * signature is a *raw Ed25519 signature* over a deterministic "signed data"
 * blob that can be built locally from the message. The wallet therefore only
 * needs the existing `raw-ed25519` `sig_hint` — no protocol changes.
 */

import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

export const SSHSIG_NAMESPACE_GIT = 'git';

const MAGIC_PREAMBLE = Buffer.from('SSHSIG', 'utf8');
const SIG_VERSION = 1;
const HASH_ALGORITHM = 'sha512';
const KEY_TYPE = 'ssh-ed25519';
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const ARMOR_HEADER = '-----BEGIN SSH SIGNATURE-----';
const ARMOR_FOOTER = '-----END SSH SIGNATURE-----';
const ARMOR_LINE_LENGTH = 70;

/** DER prefix that wraps a raw 32-byte Ed25519 public key into SPKI form. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function u32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n >>> 0);
  return buf;
}

/** SSH wire `string`: uint32 length followed by the raw bytes. */
function sshString(data: Uint8Array | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return Buffer.concat([u32(buf.length), buf]);
}

/** Read one SSH wire `string` at `offset`; returns the bytes and next offset. */
function readSshString(blob: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 4 > blob.length) throw new Error('sshsig: truncated string length');
  const length = blob.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > blob.length) throw new Error('sshsig: truncated string body');
  return { value: blob.subarray(start, end), next: end };
}

function assertPublicKey(publicKey: Uint8Array): Buffer {
  const buf = Buffer.from(publicKey);
  if (buf.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(
      `sshsig: expected a ${ED25519_PUBLIC_KEY_BYTES}-byte Ed25519 public key, got ${buf.length} bytes`,
    );
  }
  return buf;
}

/** SSH wire encoding of an Ed25519 public key (what git providers store as your signing key). */
export function encodeSshEd25519PublicKey(publicKey: Uint8Array): Buffer {
  return Buffer.concat([sshString(KEY_TYPE), sshString(assertPublicKey(publicKey))]);
}

/** `ssh-ed25519 AAAA… comment` line the user adds to their git provider as a signing key. */
export function toAuthorizedKeyLine(publicKey: Uint8Array, comment = 'ac2-wallet'): string {
  const blob = encodeSshEd25519PublicKey(publicKey).toString('base64');
  return comment.length > 0 ? `${KEY_TYPE} ${blob} ${comment}` : `${KEY_TYPE} ${blob}`;
}

/**
 * Parse an `ssh-ed25519 AAAA… [comment]` authorized-key line back to the raw
 * 32-byte public key. Accepts git's `key::` literal-signing-key prefix.
 * Returns `undefined` for anything that is not an Ed25519 authorized key.
 */
export function parseAuthorizedKeyLine(line: string): Buffer | undefined {
  let text = line.trim();
  if (text.startsWith('key::')) text = text.slice('key::'.length).trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2 || parts[0] !== KEY_TYPE) return undefined;
  let blob: Buffer;
  try {
    blob = Buffer.from(parts[1]!, 'base64');
  } catch {
    return undefined;
  }
  try {
    const type = readSshString(blob, 0);
    if (type.value.toString('utf8') !== KEY_TYPE) return undefined;
    const key = readSshString(blob, type.next);
    if (key.next !== blob.length || key.value.length !== ED25519_PUBLIC_KEY_BYTES) {
      return undefined;
    }
    return Buffer.from(key.value);
  } catch {
    return undefined;
  }
}

/**
 * Build the exact bytes the signer must raw-Ed25519 sign, per
 * `PROTOCOL.sshsig`:
 *
 *     byte[6]  MAGIC_PREAMBLE "SSHSIG"
 *     string   namespace
 *     string   reserved (empty)
 *     string   hash_algorithm ("sha512")
 *     string   H(message)
 */
export function buildSshSigSignedData(
  message: Uint8Array,
  namespace: string = SSHSIG_NAMESPACE_GIT,
): Buffer {
  const digest = createHash(HASH_ALGORITHM).update(message).digest();
  return Buffer.concat([
    MAGIC_PREAMBLE,
    sshString(namespace),
    sshString(''),
    sshString(HASH_ALGORITHM),
    sshString(digest),
  ]);
}

/**
 * Assemble the armored SSHSIG blob `git` expects in `<file>.sig`:
 *
 *     byte[6]  MAGIC_PREAMBLE
 *     uint32   SIG_VERSION (1)
 *     string   publickey (SSH wire encoded)
 *     string   namespace
 *     string   reserved
 *     string   hash_algorithm
 *     string   signature (SSH wire: string "ssh-ed25519", string sig)
 */
export function assembleSshSigArmor(
  publicKey: Uint8Array,
  rawSignature: Uint8Array,
  namespace: string = SSHSIG_NAMESPACE_GIT,
): string {
  const signature = Buffer.from(rawSignature);
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new Error(
      `sshsig: expected a ${ED25519_SIGNATURE_BYTES}-byte Ed25519 signature, got ${signature.length} bytes`,
    );
  }
  const blob = Buffer.concat([
    MAGIC_PREAMBLE,
    u32(SIG_VERSION),
    sshString(encodeSshEd25519PublicKey(publicKey)),
    sshString(namespace),
    sshString(''),
    sshString(HASH_ALGORITHM),
    sshString(Buffer.concat([sshString(KEY_TYPE), sshString(signature)])),
  ]);
  const base64 = blob.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += ARMOR_LINE_LENGTH) {
    lines.push(base64.slice(i, i + ARMOR_LINE_LENGTH));
  }
  return `${ARMOR_HEADER}\n${lines.join('\n')}\n${ARMOR_FOOTER}\n`;
}

/** Decoded SSHSIG signature blob (for verification/tests). */
export interface DecodedSshSig {
  version: number;
  publicKey: Buffer;
  namespace: string;
  hashAlgorithm: string;
  signature: Buffer;
}

/** Decode an armored SSHSIG produced by {@link assembleSshSigArmor} (or ssh-keygen). */
export function decodeSshSigArmor(armored: string): DecodedSshSig {
  const body = armored
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== ARMOR_HEADER && l !== ARMOR_FOOTER)
    .join('');
  const blob = Buffer.from(body, 'base64');
  if (!blob.subarray(0, MAGIC_PREAMBLE.length).equals(MAGIC_PREAMBLE)) {
    throw new Error('sshsig: bad magic preamble');
  }
  let offset = MAGIC_PREAMBLE.length;
  const version = blob.readUInt32BE(offset);
  offset += 4;
  const pub = readSshString(blob, offset);
  offset = pub.next;
  const namespace = readSshString(blob, offset);
  offset = namespace.next;
  const reserved = readSshString(blob, offset);
  offset = reserved.next;
  const hashAlgorithm = readSshString(blob, offset);
  offset = hashAlgorithm.next;
  const sigWire = readSshString(blob, offset);

  const keyType = readSshString(pub.value, 0);
  if (keyType.value.toString('utf8') !== KEY_TYPE) {
    throw new Error(`sshsig: unsupported key type ${keyType.value.toString('utf8')}`);
  }
  const publicKey = readSshString(pub.value, keyType.next).value;

  const sigType = readSshString(sigWire.value, 0);
  if (sigType.value.toString('utf8') !== KEY_TYPE) {
    throw new Error(`sshsig: unsupported signature type ${sigType.value.toString('utf8')}`);
  }
  const signature = readSshString(sigWire.value, sigType.next).value;

  return {
    version,
    publicKey: Buffer.from(publicKey),
    namespace: namespace.value.toString('utf8'),
    hashAlgorithm: hashAlgorithm.value.toString('utf8'),
    signature: Buffer.from(signature),
  };
}

/** Verify a raw Ed25519 signature over arbitrary bytes with a raw 32-byte key. */
export function verifyEd25519(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, assertPublicKey(publicKey)]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, Buffer.from(message), keyObject, Buffer.from(signature));
  } catch {
    return false;
  }
}
