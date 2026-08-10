/**
 * `openclaw ac2 git-config` plumbing: resolve the wallet's signing key, apply
 * the repo's identity + push-credential `git config` entries, and persist the
 * setup marker that stops agents re-running onboarding. Signing itself needs
 * no git configuration — see `./resign.ts`.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { decodeAddress } from '@algorandfoundation/algokit-utils/common';

import { loadAc2State } from '@algorandfoundation/ac2-cli/identity';
import { sessionManager } from '../session/manager.js';
import {
  controllerDidToAlgorandAddress,
  sessionAlgorandAddress,
} from '../session/wallet-address.js';
import { resolveOpenClawConfigPath } from '../setup/config.js';

/** Directory for AC2 runtime state (setup marker, push credentials). */
export function resolveAc2StateDir(): string {
  return join(dirname(resolveOpenClawConfigPath()), 'ac2');
}

/**
 * The wallet's account Ed25519 public key, used as the git signing key. An
 * Algorand address *is* the account's Ed25519 key, so decoding it yields the
 * SSH signing key directly. Falls back to the persisted bound controller when
 * no session is live (e.g. a fresh CLI process).
 */
export function resolveWalletSigningPublicKey():
  | { address: string; publicKey: Uint8Array }
  | undefined {
  const active = sessionManager.getActive();
  const boundControllerDid = loadAc2State().identity?.controllerDid;
  const address = active
    ? sessionAlgorandAddress(active)
    : boundControllerDid
      ? controllerDidToAlgorandAddress(boundControllerDid)
      : undefined;
  if (!address) return undefined;
  return { address, publicKey: decodeAddress(address).publicKey };
}

export const NO_WALLET_KEY_MESSAGE =
  'No wallet key available: pair a wallet first (`openclaw ac2 pair`) so the ' +
  "controller's account key is known.";

export interface GitConfigOptions {
  repoDir?: string;
  global?: boolean;
  name?: string;
  email?: string;
  pat?: string;
}

export const GIT_CONFIG_USAGE =
  'Usage: ac2 git-config [repo-dir] [--global] [--name <github-username>] ' +
  '[--email <email>] [--pat <token>]\n' +
  'Values may be given as `--name alice` or `--name=alice`; quote values ' +
  'containing spaces (`--name "Alice Smith"`).';

/** Parse the `git-config` subcommand arguments (`--opt value` or `--opt=value`). */
export function parseGitConfigArgs(tokens: string[]): GitConfigOptions | { error: string } {
  const opts: GitConfigOptions = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (flag === '--global') {
      opts.global = true;
    } else if (flag === '--name' || flag === '--email' || flag === '--pat') {
      const value = eq === -1 ? tokens[++i] : token.slice(eq + 1);
      if (!value || (eq === -1 && value.startsWith('--'))) {
        return { error: `missing value for ${flag}` };
      }
      if (flag === '--name') opts.name = value;
      else if (flag === '--email') opts.email = value;
      else opts.pat = value;
    } else if (flag.startsWith('--')) {
      return { error: `unknown option ${flag}` };
    } else if (opts.repoDir === undefined) {
      opts.repoDir = token;
    } else {
      return { error: `unexpected argument ${token}` };
    }
  }
  return opts;
}

/**
 * Committer identity and (optionally) push-credential `git config` entries.
 * No signing entries — `ac2 git-resign` signs, not git. A PAT is written to a
 * mode-0600 credential-store file under the AC2 state dir and wired via
 * `credential.helper`, so the token never appears in git config or output.
 */
export function buildGitConfigEntries(opts: GitConfigOptions): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (opts.name) entries.push(['user.name', opts.name]);
  if (opts.email) entries.push(['user.email', opts.email]);
  if (opts.pat) {
    const stateDir = resolveAc2StateDir();
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const credentialsPath = join(stateDir, 'git-credentials');
    const username = opts.name ?? 'x-access-token';
    writeFileSync(
      credentialsPath,
      `https://${encodeURIComponent(username)}:${encodeURIComponent(opts.pat)}@github.com\n`,
      { mode: 0o600 },
    );
    chmodSync(credentialsPath, 0o600);
    entries.push(['credential.helper', `store --file=${credentialsPath}`]);
  }
  return entries;
}

/** Apply the entries with `git config` in the target repo (or `--global`). */
export function applyGitConfigEntries(
  entries: Array<[string, string]>,
  target: { repoDir?: string; global?: boolean },
): void {
  if (!target.global) {
    // Fails with git's own message when the directory is not a repository.
    execFileSync('git', ['-C', target.repoDir!, 'rev-parse', '--git-dir'], { stdio: 'pipe' });
  }
  const prefix = target.global ? ['config', '--global'] : ['-C', target.repoDir!, 'config'];
  for (const [key, value] of entries) {
    execFileSync('git', [...prefix, key, value], { stdio: 'pipe' });
  }
}

/** Persisted after a successful apply, so agents don't loop back to onboarding. */
export interface GitSetupRecord {
  configuredAt: string;
  /** Repo dirs (or the literal 'global') git-config has been applied to. */
  targets: string[];
  name?: string;
  email?: string;
  /** Whether push credentials (PAT) have been stored. */
  pat?: boolean;
}

function gitSetupMarkerPath(): string {
  return join(resolveAc2StateDir(), 'git-config.json');
}

/** Read the persisted git setup marker, or undefined when never applied. */
export function readGitSetupRecord(): GitSetupRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(gitSetupMarkerPath(), 'utf8')) as GitSetupRecord;
    if (parsed && Array.isArray(parsed.targets)) return parsed;
  } catch {
    // Missing or corrupt marker — treat as not configured.
  }
  return undefined;
}

/** Record (or extend) the git setup marker after a successful apply. */
export function recordGitSetup(target: string, opts: GitConfigOptions): void {
  const prev = readGitSetupRecord();
  const name = opts.name ?? prev?.name;
  const email = opts.email ?? prev?.email;
  const record: GitSetupRecord = {
    configuredAt: new Date().toISOString(),
    targets: [...new Set([...(prev?.targets ?? []), target])],
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(opts.pat || prev?.pat ? { pat: true } : {}),
  };
  mkdirSync(resolveAc2StateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(gitSetupMarkerPath(), `${JSON.stringify(record, null, 2)}\n`);
}

/** Prepended to `github-key` output once setup is done, to stop agents redoing it. */
export function gitSetupAlreadyConfiguredNotice(record: GitSetupRecord): string[] {
  const identity = record.name
    ? ` · identity: ${record.name}${record.email ? ` <${record.email}>` : ''}`
    : '';
  return [
    `NOTE — git signing is ALREADY CONFIGURED (${record.targets.join(', ')}${identity}${record.pat ? ' · push credentials stored' : ''}).`,
    'Agent: setup is done. Do NOT show this key again, do NOT re-ask for the',
    'username/email/PAT, and do NOT re-run `ac2 git-config` unless the user',
    'explicitly asks. Just run `git commit`, then `openclaw ac2 git-resign',
    '<repo-dir>` before pushing — the wallet prompts for approval per commit.',
    'The key below is for reference only.',
    '',
  ];
}
