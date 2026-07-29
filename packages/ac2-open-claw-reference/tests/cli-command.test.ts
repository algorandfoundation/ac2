import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isMissingWebRtcError,
  shouldSeedConnectionId,
  tokenizeArgs,
} from '../src/cli/ac2-command.js';
import {
  applyGitConfigEntries,
  gitSetupAlreadyConfiguredNotice,
  parseGitConfigArgs,
  readGitSetupRecord,
  recordGitSetup,
  writeGitSigningAssets,
} from '../src/git/config.js';

function moduleLoadError(
  code: 'ERR_MODULE_NOT_FOUND' | 'MODULE_NOT_FOUND',
  message: string,
): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe('ac2 command WebRTC error handling', () => {
  it('matches missing @roamhq/wrtc package import failures', () => {
    expect(
      isMissingWebRtcError(
        moduleLoadError(
          'ERR_MODULE_NOT_FOUND',
          "Cannot find package '@roamhq/wrtc' imported from /plugin/dist/providers.liquid-auth.js",
        ),
      ),
    ).toBe(true);
  });

  it('matches missing @roamhq/wrtc platform optional dependency failures', () => {
    expect(
      isMissingWebRtcError(
        moduleLoadError('MODULE_NOT_FOUND', "Cannot find module '@roamhq/wrtc-darwin-arm64'"),
      ),
    ).toBe(true);
  });

  it('matches @roamhq/wrtc binary search failures', () => {
    expect(
      isMissingWebRtcError(
        new Error(
          'Could not find wrtc binary on any of the paths: ../build-darwin-arm64/wrtc.node,@roamhq/wrtc-darwin-arm64',
        ),
      ),
    ).toBe(true);
  });

  it('does not mask runtime errors from the WebRTC stack', () => {
    const err = new Error('RTCDataChannel failed inside @roamhq/wrtc');
    err.stack = 'Error: RTCDataChannel failed\n    at node_modules/@roamhq/wrtc/lib/index.js';

    expect(isMissingWebRtcError(err)).toBe(false);
  });

  it('does not match unrelated module-load failures', () => {
    expect(
      isMissingWebRtcError(
        moduleLoadError('MODULE_NOT_FOUND', "Cannot find module 'socket.io-client'"),
      ),
    ).toBe(false);
  });
});

describe('shouldSeedConnectionId', () => {
  it('seeds the stable connection id from the first pairing when none is persisted', () => {
    expect(shouldSeedConnectionId(undefined, 'req-fresh')).toBe(true);
    expect(shouldSeedConnectionId('', 'req-fresh')).toBe(true);
  });

  it('never re-seeds once a stable connection id already exists (reconnect keeps the id)', () => {
    // The whole point of the fix: a reconnect mints a *fresh* Liquid Auth
    // requestId, but the persisted connection id must stay put so history and
    // identity are not orphaned.
    expect(shouldSeedConnectionId('stable-connection-id', 'req-fresh')).toBe(false);
  });

  it('does not seed when the freshly-minted requestId is missing or blank', () => {
    expect(shouldSeedConnectionId(undefined, undefined)).toBe(false);
    expect(shouldSeedConnectionId(undefined, '')).toBe(false);
    expect(shouldSeedConnectionId(undefined, 42)).toBe(false);
  });
});

describe('parseGitConfigArgs', () => {
  it('parses a repo dir with identity and pat options', () => {
    expect(
      parseGitConfigArgs(['/work/repo', '--name', 'alice', '--email', 'a@ex.com', '--pat', 'tok']),
    ).toEqual({ repoDir: '/work/repo', name: 'alice', email: 'a@ex.com', pat: 'tok' });
  });

  it('parses --global with no repo dir', () => {
    expect(parseGitConfigArgs(['--global'])).toEqual({ global: true });
  });

  it('returns empty options for no args (print-only mode)', () => {
    expect(parseGitConfigArgs([])).toEqual({});
  });

  it('rejects missing option values, unknown options, and extra positionals', () => {
    expect(parseGitConfigArgs(['--name'])).toEqual({ error: 'missing value for --name' });
    expect(parseGitConfigArgs(['--name', '--email'])).toEqual({
      error: 'missing value for --name',
    });
    expect(parseGitConfigArgs(['--bogus'])).toEqual({ error: 'unknown option --bogus' });
    expect(parseGitConfigArgs(['a', 'b'])).toEqual({ error: 'unexpected argument b' });
  });

  it('accepts --opt=value syntax', () => {
    expect(parseGitConfigArgs(['/r', '--name=alice', '--email=a@ex.com', '--pat=t=ok'])).toEqual({
      repoDir: '/r',
      name: 'alice',
      email: 'a@ex.com',
      pat: 't=ok',
    });
    expect(parseGitConfigArgs(['--name='])).toEqual({ error: 'missing value for --name' });
    expect(parseGitConfigArgs(['--bogus=x'])).toEqual({ error: 'unknown option --bogus' });
  });
});

describe('tokenizeArgs', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenizeArgs('git-config /r --name "Alice Smith" --email a@ex.com')).toEqual([
      'git-config',
      '/r',
      '--name',
      'Alice Smith',
      '--email',
      'a@ex.com',
    ]);
    expect(tokenizeArgs("--name 'Alice Smith'")).toEqual(['--name', 'Alice Smith']);
    expect(tokenizeArgs('  ')).toEqual([]);
  });
});

const hasGit = spawnSync('git', ['--version']).error === undefined;

describe.runIf(hasGit)('applyGitConfigEntries', () => {
  it('applies entries to a target repo', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'ac2-git-config-'));
    spawnSync('git', ['-C', repoDir, 'init', '-q']);

    applyGitConfigEntries(
      [
        ['gpg.format', 'ssh'],
        ['user.signingkey', 'key::ssh-ed25519 AAAA test'],
        ['user.email', 'a@ex.com'],
      ],
      { repoDir },
    );

    const readBack = (key: string): string =>
      spawnSync('git', ['-C', repoDir, 'config', key], { encoding: 'utf8' }).stdout.trim();
    expect(readBack('gpg.format')).toBe('ssh');
    expect(readBack('user.signingkey')).toBe('key::ssh-ed25519 AAAA test');
    expect(readBack('user.email')).toBe('a@ex.com');
  });

  it('fails when the target directory is not a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac2-not-a-repo-'));
    expect(() => applyGitConfigEntries([['gpg.format', 'ssh']], { repoDir: dir })).toThrow();
  });
});

describe('writeGitSigningAssets', () => {
  it('bakes the bridge socket path into the wrapper as an overridable default', () => {
    const prev = process.env.OPENCLAW_STATE_DIR;
    const stateDir = mkdtempSync(join(tmpdir(), 'ac2-assets-'));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const keyLine = 'ssh-ed25519 AAAA test';
      const { wrapperPath, allowedSignersPath } = writeGitSigningAssets(keyLine);

      const wrapper = readFileSync(wrapperPath, 'utf8');
      // Baked at config time so git's (possibly different) shell environment
      // cannot resolve a divergent path — but an explicit env var still wins.
      expect(wrapper).toContain(
        `: "\${AC2_GIT_SIGN_SOCKET:=${join(stateDir, 'ac2', 'git-sign.sock')}}"`,
      );
      expect(wrapper).toContain('export AC2_GIT_SIGN_SOCKET');
      expect(wrapper).toContain(`exec "${process.execPath}"`);

      expect(readFileSync(allowedSignersPath, 'utf8')).toBe(`* namespaces="git" ${keyLine}\n`);
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prev;
    }
  });
});

describe('git setup marker', () => {
  it('round-trips, accumulates targets, and keeps prior identity/pat', () => {
    const prev = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = mkdtempSync(join(tmpdir(), 'ac2-marker-'));
    try {
      expect(readGitSetupRecord()).toBeUndefined();

      recordGitSetup('/work/repo-a', { name: 'alice', email: 'a@ex.com', pat: 'tok' });
      recordGitSetup('/work/repo-b', {});
      recordGitSetup('/work/repo-a', {});

      const record = readGitSetupRecord();
      expect(record?.targets).toEqual(['/work/repo-a', '/work/repo-b']);
      expect(record?.name).toBe('alice');
      expect(record?.email).toBe('a@ex.com');
      expect(record?.pat).toBe(true);

      const notice = gitSetupAlreadyConfiguredNotice(record!).join('\n');
      expect(notice).toContain('ALREADY CONFIGURED');
      expect(notice).toContain('alice <a@ex.com>');
      expect(notice).not.toContain('tok');
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prev;
    }
  });
});
