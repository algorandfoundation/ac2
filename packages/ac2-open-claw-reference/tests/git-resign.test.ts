import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../src/session/manager.js';
import { walletFixture } from './wallet-fixture.js';
import {
  insertGpgsigHeader,
  resignCommits,
  rewriteParentHeaders,
  stripGpgsigHeader,
} from '../src/git/resign.js';
import {
  buildSshSigSignedData,
  decodeSshSigArmor,
  toAuthorizedKeyLine,
  verifyEd25519,
} from '../src/git/sshsig.js';

const COMMIT = Buffer.from(
  [
    'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    'parent 1111111111111111111111111111111111111111',
    'author Ada <ada@example.com> 1700000000 +0000',
    'committer Ada <ada@example.com> 1700000000 +0000',
    '',
    'feat: subject line',
    '',
    'Body.',
    '',
  ].join('\n'),
);

const ARMOR = '-----BEGIN SSH SIGNATURE-----\nAAAA\nBBBB\n-----END SSH SIGNATURE-----\n';

function git(repoDir: string, args: string[], input?: Buffer): Buffer {
  return execFileSync('git', ['-C', repoDir, ...args], {
    ...(input !== undefined ? { input } : {}),
  });
}

/** A fresh repo with signing off and a deterministic identity. */
function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'ac2-resign-'));
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.name', 'Ada']);
  git(repoDir, ['config', 'user.email', 'ada@example.com']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  return repoDir;
}

function commit(repoDir: string, message: string): string {
  writeFileSync(join(repoDir, 'file.txt'), `${message}\n`);
  git(repoDir, ['add', 'file.txt']);
  git(repoDir, ['commit', '-q', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']).toString('utf8').trim();
}

describe('gpgsig header helpers', () => {
  it('inserts the armor as a space-continued gpgsig header before the message', () => {
    const signed = insertGpgsigHeader(COMMIT, ARMOR);
    const text = signed.toString('utf8');
    expect(text).toContain(
      [
        'committer Ada <ada@example.com> 1700000000 +0000',
        'gpgsig -----BEGIN SSH SIGNATURE-----',
        ' AAAA',
        ' BBBB',
        ' -----END SSH SIGNATURE-----',
        '',
        'feat: subject line',
      ].join('\n'),
    );
  });

  it('strip is the exact inverse of insert', () => {
    const signed = insertGpgsigHeader(COMMIT, ARMOR);
    const stripped = stripGpgsigHeader(signed);
    expect(stripped.hadSignature).toBe(true);
    expect(stripped.payload.equals(COMMIT)).toBe(true);
  });

  it('strip leaves unsigned payloads untouched', () => {
    const stripped = stripGpgsigHeader(COMMIT);
    expect(stripped.hadSignature).toBe(false);
    expect(stripped.payload).toBe(COMMIT);
  });

  it('refuses to double-insert', () => {
    const signed = insertGpgsigHeader(COMMIT, ARMOR);
    expect(() => insertGpgsigHeader(signed, ARMOR)).toThrow(/already has a gpgsig header/);
  });

  it('rewrites mapped parent headers and leaves others alone', () => {
    const mapping = new Map([
      ['1111111111111111111111111111111111111111', '2222222222222222222222222222222222222222'],
    ]);
    const rewritten = rewriteParentHeaders(COMMIT, mapping);
    expect(rewritten.toString('utf8')).toContain(
      'parent 2222222222222222222222222222222222222222',
    );
    expect(rewriteParentHeaders(COMMIT, new Map([['dead', 'beef']]))).toBe(COMMIT);
  });
});

describe('resignCommits', () => {
  it('signs HEAD in place with a verifiable SSHSIG and moves the branch', async () => {
    const { manager, rawPublicKey } = walletFixture();
    const repoDir = makeRepo();
    const oldSha = commit(repoDir, 'feat: one');

    const result = await resignCommits({ repoDir }, {}, { manager });
    expect(result.status).toBe('signed');
    if (result.status !== 'signed') return;
    expect(result.oldTip).toBe(oldSha);
    expect(git(repoDir, ['rev-parse', 'HEAD']).toString('utf8').trim()).toBe(result.newTip);

    // The rewritten commit is intact (same tree/message) and fsck-clean.
    const raw = git(repoDir, ['cat-file', 'commit', 'HEAD']);
    expect(raw.toString('utf8')).toContain('gpgsig -----BEGIN SSH SIGNATURE-----');
    expect(raw.toString('utf8')).toContain('feat: one');
    git(repoDir, ['fsck', '--strict']);

    // The signature verifies over the stripped payload under the git namespace.
    const { payload } = stripGpgsigHeader(raw);
    const lines = raw.toString('utf8').split('\n');
    const start = lines.findIndex((l) => l.startsWith('gpgsig '));
    const armorLines = [lines[start]!.slice('gpgsig '.length)];
    for (let i = start + 1; i < lines.length && lines[i]!.startsWith(' '); i++) {
      armorLines.push(lines[i]!.slice(1));
    }
    const decoded = decodeSshSigArmor(armorLines.join('\n'));
    expect(decoded.publicKey.equals(rawPublicKey)).toBe(true);
    expect(
      verifyEd25519(buildSshSigSignedData(payload, 'git'), decoded.signature, decoded.publicKey),
    ).toBe(true);
  });

  it('passes git verify-commit when the key is an allowed signer', async () => {
    const { manager, rawPublicKey } = walletFixture();
    const repoDir = makeRepo();
    commit(repoDir, 'feat: verified');

    const result = await resignCommits({ repoDir }, {}, { manager });
    expect(result.status).toBe('signed');

    const signersPath = join(repoDir, 'allowed_signers');
    writeFileSync(signersPath, `ada@example.com ${toAuthorizedKeyLine(rawPublicKey)}\n`);
    git(repoDir, ['config', 'gpg.format', 'ssh']);
    git(repoDir, ['config', 'gpg.ssh.allowedSignersFile', signersPath]);
    // git shells out to ssh-keygen for SSHSIG verification; hosts without
    // it can't run this check at all.
    if (spawnSync('ssh-keygen', []).error) return;
    git(repoDir, ['verify-commit', 'HEAD']);
  });

  it('re-signs a range oldest-first, rewriting the parent chain', async () => {
    const { manager } = walletFixture();
    const repoDir = makeRepo();
    const base = commit(repoDir, 'feat: base');
    const first = commit(repoDir, 'feat: first');
    const second = commit(repoDir, 'feat: second');

    const result = await resignCommits({ repoDir, base }, {}, { manager });
    expect(result.status).toBe('signed');
    if (result.status !== 'signed') return;
    expect(result.commits.map((c) => c.oldSha)).toEqual([first, second]);
    expect(result.commits.map((c) => c.subject)).toEqual(['feat: first', 'feat: second']);

    // The new tip's parent is the re-signed first commit, and both carry sigs.
    const newFirst = result.commits[0]!.newSha;
    const tip = git(repoDir, ['cat-file', 'commit', 'HEAD']).toString('utf8');
    expect(tip).toContain(`parent ${newFirst}`);
    expect(tip).toContain('gpgsig ');
    expect(git(repoDir, ['cat-file', 'commit', newFirst]).toString('utf8')).toContain('gpgsig ');
    git(repoDir, ['fsck', '--strict']);
  });

  it('strips and re-signs a tip signed by a foreign key', async () => {
    // The "machine's own git signing config" case: the tip carries a valid
    // SSHSIG by some other key — resign must replace it, not skip it.
    const foreign = walletFixture();
    const { manager, rawPublicKey, requests } = walletFixture();
    const repoDir = makeRepo();
    commit(repoDir, 'feat: locally-signed');
    const foreignResult = await resignCommits({ repoDir }, {}, { manager: foreign.manager });
    expect(foreignResult.status).toBe('signed');

    const result = await resignCommits({ repoDir }, {}, { manager });
    expect(result.status).toBe('signed');
    expect(requests).toHaveLength(1);

    const raw = git(repoDir, ['cat-file', 'commit', 'HEAD']);
    const { payload } = stripGpgsigHeader(raw);
    const lines = raw.toString('utf8').split('\n');
    const start = lines.findIndex((l) => l.startsWith('gpgsig '));
    const armorLines = [lines[start]!.slice('gpgsig '.length)];
    for (let i = start + 1; i < lines.length && lines[i]!.startsWith(' '); i++) {
      armorLines.push(lines[i]!.slice(1));
    }
    const decoded = decodeSshSigArmor(armorLines.join('\n'));
    expect(decoded.publicKey.equals(rawPublicKey)).toBe(true);
    expect(decoded.publicKey.equals(foreign.rawPublicKey)).toBe(false);
    expect(
      verifyEd25519(buildSshSigSignedData(payload, 'git'), decoded.signature, decoded.publicKey),
    ).toBe(true);
  });

  it('is a no-op on an already-signed tip', async () => {
    const { manager, requests } = walletFixture();
    const repoDir = makeRepo();
    commit(repoDir, 'feat: once');
    await resignCommits({ repoDir }, {}, { manager });
    const signedTip = git(repoDir, ['rev-parse', 'HEAD']).toString('utf8').trim();

    const again = await resignCommits({ repoDir }, {}, { manager });
    expect(again).toEqual({ status: 'rejected', reason: 'already_signed' });
    expect(git(repoDir, ['rev-parse', 'HEAD']).toString('utf8').trim()).toBe(signedTip);
    expect(requests).toHaveLength(1);
  });

  it('leaves the ref untouched when the wallet rejects', async () => {
    const { manager } = walletFixture({}, () => ({
      kind: 'rejected',
      message: { thid: 'thid-1', body: { reason: 'user_declined' } },
    }));
    const repoDir = makeRepo();
    const sha = commit(repoDir, 'feat: declined');

    const result = await resignCommits({ repoDir }, {}, { manager });
    expect(result).toEqual({ status: 'rejected', reason: 'user_declined' });
    expect(git(repoDir, ['rev-parse', 'HEAD']).toString('utf8').trim()).toBe(sha);
  });

  it('rejects with no_active_session when no wallet is paired and no daemon runs', async () => {
    const repoDir = makeRepo();
    commit(repoDir, 'feat: offline');
    const result = await resignCommits(
      { repoDir },
      {},
      { manager: new SessionManager(), connect: async () => undefined },
    );
    expect(result).toEqual({ status: 'rejected', reason: 'no_active_session' });
  });

  it('signs via the daemon when no in-process session exists', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const rawPublicKey = Buffer.from(spki.subarray(spki.length - 32));
    const daemon = {
      async request(_method: string, args: any) {
        const payload = Buffer.from(args.body.payload, 'base64');
        return {
          message: {
            type: 'ac2/SigningResponse',
            thid: 'thid-daemon',
            body: {
              signature: cryptoSign(null, payload, privateKey).toString('base64'),
              public_key: rawPublicKey.toString('base64'),
            },
          },
        };
      },
      close() {},
    };

    const repoDir = makeRepo();
    commit(repoDir, 'feat: daemon-signed');
    const result = await resignCommits(
      { repoDir },
      {},
      { manager: new SessionManager(), connect: async () => daemon as never },
    );
    expect(result.status).toBe('signed');

    const raw = git(repoDir, ['cat-file', 'commit', 'HEAD']);
    const { payload } = stripGpgsigHeader(raw);
    const lines = raw.toString('utf8').split('\n');
    const start = lines.findIndex((l) => l.startsWith('gpgsig '));
    const armorLines = [lines[start]!.slice('gpgsig '.length)];
    for (let i = start + 1; i < lines.length && lines[i]!.startsWith(' '); i++) {
      armorLines.push(lines[i]!.slice(1));
    }
    const decoded = decodeSshSigArmor(armorLines.join('\n'));
    expect(decoded.publicKey.equals(rawPublicKey)).toBe(true);
    expect(
      verifyEd25519(buildSshSigSignedData(payload, 'git'), decoded.signature, decoded.publicKey),
    ).toBe(true);
  });

  it('rejects on a directory that is not a git repo', async () => {
    const { manager } = walletFixture();
    const dir = mkdtempSync(join(tmpdir(), 'ac2-resign-notrepo-'));
    const result = await resignCommits({ repoDir: dir }, {}, { manager });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toMatch(/^git_error:/);
  });
});
