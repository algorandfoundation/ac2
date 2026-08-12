import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';

import { walletFixture } from './wallet-fixture.js';
import { describeGitPayload, gitSignFlow, parseExpectedPublicKey } from '../src/git/sign-flow.js';
import {
  buildSshSigSignedData,
  decodeSshSigArmor,
  toAuthorizedKeyLine,
  verifyEd25519,
} from '../src/git/sshsig.js';

const COMMIT = Buffer.from(
  [
    'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    'author Ada <ada@example.com> 1700000000 +0000',
    'committer Ada <ada@example.com> 1700000000 +0000',
    '',
    'feat: sign commits over AC2',
    '',
    'Body text.',
    '',
  ].join('\n'),
);

describe('describeGitPayload', () => {
  it('names commits and surfaces the subject line', () => {
    expect(describeGitPayload(COMMIT)).toBe('Sign git commit: "feat: sign commits over AC2"');
  });

  it('names tag objects', () => {
    const tag = Buffer.from('object abc\ntype commit\ntag v1\n\nrelease v1\n');
    expect(describeGitPayload(tag)).toBe('Sign git tag: "release v1"');
  });

  it('falls back for unknown payloads without a subject', () => {
    expect(describeGitPayload(Buffer.from('mystery-bytes'))).toBe('Sign git object');
  });
});

describe('gitSignFlow', () => {
  it('signs a commit and returns a verifiable armored SSHSIG', async () => {
    const { manager, rawPublicKey, requests } = walletFixture();
    const result = await gitSignFlow({ payload_base64: COMMIT.toString('base64') }, {}, { manager });

    expect(result.status).toBe('signed');
    if (result.status !== 'signed') return;
    expect(result.public_key).toBe(rawPublicKey.toString('base64'));
    expect(result.authorized_key).toBe(toAuthorizedKeyLine(rawPublicKey));
    expect(result.namespace).toBe('git');
    expect(result.thid).toBe('thid-1');

    // The wallet was asked to raw-ed25519 sign the SSHSIG blob, not the commit.
    const request = requests[0] as any;
    expect(request.body.sig_hint).toBe('raw-ed25519');
    expect(request.body.schema).toBe('sshsig');
    expect(request.body.key_type).toBe('account');
    expect(Buffer.from(request.body.payload, 'base64')).toEqual(buildSshSigSignedData(COMMIT));
    expect(request.body.description).toContain('feat: sign commits over AC2');

    const decoded = decodeSshSigArmor(result.armored);
    expect(decoded.publicKey).toEqual(rawPublicKey);
    expect(
      verifyEd25519(buildSshSigSignedData(COMMIT), decoded.signature, decoded.publicKey),
    ).toBe(true);
  });

  it('pins the expected public key and rejects a mismatched signer', async () => {
    const { manager } = walletFixture();
    const { publicKey: otherPub } = generateKeyPairSync('ed25519');
    const otherSpki = otherPub.export({ format: 'der', type: 'spki' }) as Buffer;
    const otherRaw = Buffer.from(otherSpki.subarray(otherSpki.length - 32));

    const result = await gitSignFlow(
      {
        payload_base64: COMMIT.toString('base64'),
        expected_public_key: toAuthorizedKeyLine(otherRaw),
      },
      {},
      { manager },
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toContain('public_key_mismatch');
  });

  it('accepts the expected key when it matches (key:: literal form)', async () => {
    const { manager, rawPublicKey } = walletFixture();
    const result = await gitSignFlow(
      {
        payload_base64: COMMIT.toString('base64'),
        expected_public_key: `key::${toAuthorizedKeyLine(rawPublicKey)}`,
      },
      {},
      { manager },
    );
    expect(result.status).toBe('signed');
  });

  it('rejects a wallet response whose signature does not verify', async () => {
    const { manager } = walletFixture({}, () => ({
      kind: 'response',
      message: {
        thid: 'thid-bad',
        body: {
          signature: Buffer.alloc(64).toString('base64'),
          public_key: Buffer.alloc(32, 7).toString('base64'),
        },
      },
    }));
    const result = await gitSignFlow({ payload_base64: COMMIT.toString('base64') }, {}, { manager });
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid_signature' });
  });

  it('propagates wallet rejections', async () => {
    const { manager } = walletFixture({}, () => ({
      kind: 'rejected',
      message: { thid: 'thid-2', body: { reason: 'user_declined' } },
    }));
    const result = await gitSignFlow({ payload_base64: COMMIT.toString('base64') }, {}, { manager });
    expect(result).toMatchObject({ status: 'rejected', reason: 'user_declined' });
  });

  it('rejects when the session has no granted identity', async () => {
    const { manager } = walletFixture({ identityGranted: false });
    const result = await gitSignFlow({ payload_base64: COMMIT.toString('base64') }, {}, { manager });
    expect(result).toMatchObject({ status: 'rejected', reason: 'no_identity' });
  });

  it('rejects empty and malformed inputs without contacting the wallet', async () => {
    const { manager, requests } = walletFixture();
    expect(await gitSignFlow({ payload_base64: '' }, {}, { manager })).toMatchObject({
      status: 'rejected',
      reason: 'empty_payload',
    });
    expect(
      await gitSignFlow(
        { payload_base64: COMMIT.toString('base64'), expected_public_key: 'not-a-key' },
        {},
        { manager },
      ),
    ).toMatchObject({ status: 'rejected', reason: 'invalid_expected_public_key' });
    expect(requests).toHaveLength(0);
  });
});

describe('parseExpectedPublicKey', () => {
  it('accepts raw base64 32-byte keys', () => {
    const raw = Buffer.alloc(32, 3);
    expect(parseExpectedPublicKey(raw.toString('base64'))).toEqual(raw);
  });

  it('rejects wrong-size raw keys', () => {
    expect(parseExpectedPublicKey(Buffer.alloc(16).toString('base64'))).toBeUndefined();
  });
});
