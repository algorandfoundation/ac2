/** `did:key:z…` normalization for the same Ed25519 key arriving in base58btc, Algorand base32, or base64. */

const DID_KEY_PREFIX = 'did:key:';
const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base58btcEncode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let k = 0; k < bytes.length && bytes[k] === 0; k++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i] as number];
  return out;
}

function base58btcDecode(str: string): Uint8Array | undefined {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const val = BASE58_ALPHABET.indexOf(str[i] as string);
    if (val < 0) return undefined;
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
  bytes.reverse();
  return new Uint8Array(bytes);
}

function base32Decode(str: string): Uint8Array | undefined {
  const s = str.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s) {
    const idx = BASE32_ALPHABET.indexOf(c);
    if (idx < 0) return undefined;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function tryBase64Decode(s: string): Uint8Array | undefined {
  try {
    const norm = s.replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]+=*$/.test(norm)) return undefined;
    const buf = Buffer.from(norm, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return undefined;
  }
}

/** Build `did:key:z…` from a 32-byte Ed25519 public key. */
export function publicKeyToDidKey(publicKey: Uint8Array): string {
  const data = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  data.set(ED25519_MULTICODEC_PREFIX, 0);
  data.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return `${DID_KEY_PREFIX}z${base58btcEncode(data)}`;
}

/** Extract the 32-byte Ed25519 key from any supported `did:key` encoding. */
export function extractEd25519PublicKey(value: string): Uint8Array | undefined {
  let id = value.startsWith(DID_KEY_PREFIX) ? value.slice(DID_KEY_PREFIX.length) : value;
  if (!id) return undefined;

  if (id.startsWith('z')) {
    const decoded = base58btcDecode(id.slice(1));
    if (
      decoded &&
      decoded.length === 34 &&
      decoded[0] === ED25519_MULTICODEC_PREFIX[0] &&
      decoded[1] === ED25519_MULTICODEC_PREFIX[1]
    ) {
      return decoded.slice(2);
    }
    if (decoded && decoded.length === 32) return decoded;
    return undefined;
  }

  if (/^[A-Z2-7]{58}$/.test(id)) {
    const decoded = base32Decode(id);
    if (decoded && decoded.length >= 32) return decoded.slice(0, 32);
    return undefined;
  }

  const b64 = tryBase64Decode(id);
  if (b64 && b64.length === 32) return b64;

  return undefined;
}

/** Normalize a `did:key` (or bare key) into canonical `did:key:z…`. */
export function normalizeDidKey(value: string): string {
  const pk = extractEd25519PublicKey(value);
  if (!pk) return value;
  return publicKeyToDidKey(pk);
}
