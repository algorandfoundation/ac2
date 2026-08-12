import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SSHSIG_NAMESPACE_GIT,
  assembleSshSigArmor,
  buildSshSigSignedData,
  decodeSshSigArmor,
  encodeSshEd25519PublicKey,
  parseAuthorizedKeyLine,
  toAuthorizedKeyLine,
  verifyEd25519,
} from '../src/git/sshsig.js';

function ed25519Fixture(): {
  rawPublicKey: Buffer;
  signRaw: (data: Uint8Array) => Buffer;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    rawPublicKey: Buffer.from(spki.subarray(spki.length - 32)),
    signRaw: (data) => cryptoSign(null, Buffer.from(data), privateKey),
  };
}

const hasSshKeygen = spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' }).error === undefined;

describe('sshsig — authorized key lines', () => {
  it('round-trips a 32-byte key through the authorized-key line form', () => {
    const { rawPublicKey } = ed25519Fixture();
    const line = toAuthorizedKeyLine(rawPublicKey, 'test-comment');
    expect(line).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ test-comment$/);
    expect(parseAuthorizedKeyLine(line)).toEqual(rawPublicKey);
  });

  it("accepts git's key:: literal signing-key prefix", () => {
    const { rawPublicKey } = ed25519Fixture();
    const line = `key::${toAuthorizedKeyLine(rawPublicKey)}`;
    expect(parseAuthorizedKeyLine(line)).toEqual(rawPublicKey);
  });

  it('rejects non-Ed25519 and malformed lines', () => {
    expect(parseAuthorizedKeyLine('ssh-rsa AAAAB3NzaC1yc2E= nope')).toBeUndefined();
    expect(parseAuthorizedKeyLine('ssh-ed25519')).toBeUndefined();
    expect(parseAuthorizedKeyLine('ssh-ed25519 not-base64!!!')).toBeUndefined();
    // Valid base64 but wrong wire content.
    expect(
      parseAuthorizedKeyLine(`ssh-ed25519 ${Buffer.from('junk').toString('base64')}`),
    ).toBeUndefined();
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => encodeSshEd25519PublicKey(Buffer.alloc(31))).toThrow(/32-byte/);
    expect(() => toAuthorizedKeyLine(Buffer.alloc(33))).toThrow(/32-byte/);
  });
});

describe('sshsig — signed data + armor', () => {
  it('builds the PROTOCOL.sshsig signed-data blob over SHA-512', () => {
    const message = Buffer.from('tree abc\n\nfeat: hello\n');
    const blob = buildSshSigSignedData(message);
    expect(blob.subarray(0, 6).toString('utf8')).toBe('SSHSIG');
    // namespace string follows the magic
    expect(blob.readUInt32BE(6)).toBe(SSHSIG_NAMESPACE_GIT.length);
    expect(blob.subarray(10, 10 + 3).toString('utf8')).toBe('git');
  });

  it('assembles an armored SSHSIG that decodes back to its parts', () => {
    const { rawPublicKey, signRaw } = ed25519Fixture();
    const message = Buffer.from('tree abc\nparent def\n\nfeat: sshsig\n');
    const signedData = buildSshSigSignedData(message);
    const signature = signRaw(signedData);

    const armored = assembleSshSigArmor(rawPublicKey, signature);
    expect(armored.startsWith('-----BEGIN SSH SIGNATURE-----\n')).toBe(true);
    expect(armored.endsWith('-----END SSH SIGNATURE-----\n')).toBe(true);

    const decoded = decodeSshSigArmor(armored);
    expect(decoded.version).toBe(1);
    expect(decoded.namespace).toBe('git');
    expect(decoded.hashAlgorithm).toBe('sha512');
    expect(decoded.publicKey).toEqual(rawPublicKey);
    expect(decoded.signature).toEqual(Buffer.from(signature));
    expect(verifyEd25519(signedData, decoded.signature, decoded.publicKey)).toBe(true);
  });

  it('rejects signatures that are not 64 bytes', () => {
    const { rawPublicKey } = ed25519Fixture();
    expect(() => assembleSshSigArmor(rawPublicKey, Buffer.alloc(63))).toThrow(/64-byte/);
  });

  it('verifyEd25519 fails closed on garbage input', () => {
    const { rawPublicKey } = ed25519Fixture();
    expect(verifyEd25519(Buffer.from('msg'), Buffer.alloc(64), rawPublicKey)).toBe(false);
    expect(verifyEd25519(Buffer.from('msg'), Buffer.alloc(64), Buffer.alloc(31))).toBe(false);
  });

  it.runIf(hasSshKeygen)('produces a signature ssh-keygen accepts (check-novalidate)', () => {
    const { rawPublicKey, signRaw } = ed25519Fixture();
    const message = Buffer.from('tree abc\nauthor a <a@b.c> 0 +0000\n\nfeat: interop\n');
    const armored = assembleSshSigArmor(rawPublicKey, signRaw(buildSshSigSignedData(message)));

    const dir = mkdtempSync(join(tmpdir(), 'ac2-sshsig-'));
    const sigPath = join(dir, 'payload.sig');
    writeFileSync(sigPath, armored);

    const result = spawnSync('ssh-keygen', ['-Y', 'check-novalidate', '-n', 'git', '-s', sigPath], {
      input: message,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
