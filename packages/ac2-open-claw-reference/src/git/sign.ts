/**
 * Sign-after-commit: `git commit` creates the commit unsigned, then it is
 * rewritten in place. An unsigned commit's raw payload IS the SSHSIG
 * signed-data input, so no git-side signing configuration is needed.
 *
 * Trade-offs: commits exist unsigned until signed (nothing in git enforces
 * the signing step — the skill instructions do), and rewriting a parent changes
 * every descendant hash, so ranges are signed oldest first with parent headers
 * rewritten along the way.
 */

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';

import type { PluginConfig, ToolContext } from '../session/contracts.js';
import type { ResolveSignDeps } from '../session/flows.js';
import { NoActiveSessionError } from '../session/manager.js';
import { resolveWalletSigningPublicKey } from './config.js';
import { gitSignFlow, subjectLine } from './sign-flow.js';
import { buildSshSigSignedData, decodeSshSigArmor, verifyEd25519 } from './sshsig.js';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Run git in `repoDir`, returning stdout bytes; throws with stderr on failure. */
function git(repoDir: string, args: string[], input?: Buffer): Buffer {
  const result = spawnSync('git', ['-C', repoDir, ...args], {
    ...(input !== undefined ? { input } : {}),
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8').trim() ?? '';
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

/**
 * Split a raw commit payload at the header/message boundary. Header bytes are
 * handled as latin1 strings (byte-preserving) so non-UTF-8 author names
 * survive the round-trip untouched.
 */
function splitHeaders(payload: Buffer): { headerLines: string[]; message: Buffer } {
  const separator = payload.indexOf('\n\n');
  if (separator === -1) {
    throw new Error('malformed commit payload: missing header/message separator');
  }
  const headerLines = payload.subarray(0, separator).toString('latin1').split('\n');
  // `message` keeps the separating blank line so joins stay byte-exact.
  return { headerLines, message: payload.subarray(separator + 1) };
}

function joinHeaders(headerLines: string[], message: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${headerLines.join('\n')}\n`, 'latin1'), message]);
}

function isGpgsigStart(line: string): boolean {
  return /^gpgsig(-sha256)? /.test(line);
}

/**
 * Remove any `gpgsig` / `gpgsig-sha256` header (and its space-prefixed
 * continuation lines). The result is the exact payload the signature covers;
 * `armor` is the removed signature block (continuation prefixes stripped).
 */
export function stripGpgsigHeader(payload: Buffer): {
  payload: Buffer;
  hadSignature: boolean;
  armor?: string;
} {
  const { headerLines, message } = splitHeaders(payload);
  const kept: string[] = [];
  const armorLines: string[] = [];
  let inSignature = false;
  let hadSignature = false;
  for (const line of headerLines) {
    if (isGpgsigStart(line)) {
      inSignature = true;
      hadSignature = true;
      armorLines.push(line.replace(/^gpgsig(-sha256)? /, ''));
      continue;
    }
    if (inSignature && line.startsWith(' ')) {
      armorLines.push(line.slice(1));
      continue;
    }
    inSignature = false;
    kept.push(line);
  }
  if (!hadSignature) return { payload, hadSignature: false };
  return { payload: joinHeaders(kept, message), hadSignature: true, armor: armorLines.join('\n') };
}

/**
 * Insert an armored signature as a `gpgsig` header after the existing headers
 * (continuation lines prefixed with a single space, as git requires). The
 * payload must not already carry a signature — strip first.
 */
export function insertGpgsigHeader(payload: Buffer, armored: string): Buffer {
  const { headerLines, message } = splitHeaders(payload);
  if (headerLines.some(isGpgsigStart)) {
    throw new Error('commit payload already has a gpgsig header');
  }
  const armorLines = armored.trimEnd().split('\n');
  const sigLines = [`gpgsig ${armorLines[0]}`, ...armorLines.slice(1).map((l) => ` ${l}`)];
  return joinHeaders([...headerLines, ...sigLines], message);
}

/** Rewrite `parent <sha>` headers through an old→new mapping (chain signing). */
export function rewriteParentHeaders(
  payload: Buffer,
  mapping: ReadonlyMap<string, string>,
): Buffer {
  if (mapping.size === 0) return payload;
  const { headerLines, message } = splitHeaders(payload);
  let changed = false;
  const rewritten = headerLines.map((line) => {
    if (!line.startsWith('parent ')) return line;
    const replacement = mapping.get(line.slice('parent '.length));
    if (replacement === undefined) return line;
    changed = true;
    return `parent ${replacement}`;
  });
  return changed ? joinHeaders(rewritten, message) : payload;
}

export interface SignCommitsOptions {
  /** Absolute path to the git repository. */
  repoDir: string;
  /** Ref whose tip to sign; defaults to `HEAD`. */
  ref?: string;
  /**
   * When set, sign every commit in `base..ref` (oldest first), rewriting
   * parent hashes along the chain. Without it only the tip commit is signed.
   */
  base?: string;
}

/** True when `armor` is a valid SSHSIG by `walletKey` over `payload` (namespace `git`). */
function isWalletSignature(armor: string, payload: Buffer, walletKey: Uint8Array): boolean {
  try {
    const decoded = decodeSshSigArmor(armor);
    return (
      Buffer.from(walletKey).equals(decoded.publicKey) &&
      verifyEd25519(buildSshSigSignedData(payload), decoded.signature, decoded.publicKey)
    );
  } catch {
    return false;
  }
}

export type SignCommitsResult =
  | {
      status: 'signed';
      ref: string;
      oldTip: string;
      newTip: string;
      /** Old→new sha per signed commit, oldest first. */
      commits: Array<{ oldSha: string; newSha: string; subject: string }>;
    }
  | { status: 'rejected'; reason: string };

/**
 * Sign the commit(s) at `ref` via the active AC2 session and move the ref
 * to the rewritten tip. One wallet approval per commit; a rejection aborts
 * before any ref is touched (loose objects already written are harmless).
 */
export async function signCommits(
  options: SignCommitsOptions,
  config: PluginConfig,
  deps: ResolveSignDeps = {},
  context: ToolContext = {},
): Promise<SignCommitsResult> {
  const ref = options.ref ?? 'HEAD';
  let oldTip: string;
  let shas: string[];
  try {
    oldTip = git(options.repoDir, ['rev-parse', '--verify', `${ref}^{commit}`])
      .toString('utf8')
      .trim();
    shas = options.base
      ? git(options.repoDir, ['rev-list', '--reverse', `${options.base}..${oldTip}`])
          .toString('utf8')
          .split('\n')
          .filter((line) => line.length > 0)
      : [oldTip];
  } catch (err) {
    return { status: 'rejected', reason: `git_error: ${(err as Error).message}` };
  }
  if (shas.length === 0) {
    return { status: 'rejected', reason: 'no_commits_in_range' };
  }

  // The wallet's key decides whether an existing signature counts as "already
  // signed": a commit signed by any OTHER key (e.g. the machine's own git
  // signing config auto-signing `git commit`) is stripped and wallet-signed.
  // When no wallet key is resolvable, fall back to skipping any signed commit.
  const walletKey = resolveWalletSigningPublicKey(deps.manager)?.publicKey;

  const mapping = new Map<string, string>();
  const commits: Array<{ oldSha: string; newSha: string; subject: string }> = [];
  for (const sha of shas) {
    const raw = git(options.repoDir, ['cat-file', 'commit', sha]);
    const withParents = rewriteParentHeaders(raw, mapping);
    const { payload, hadSignature, armor } = stripGpgsigHeader(withParents);
    if (
      hadSignature &&
      withParents === raw &&
      (walletKey === undefined ||
        (armor !== undefined && isWalletSignature(armor, payload, walletKey)))
    ) {
      // Already wallet-signed and its parents are untouched: nothing to redo.
      continue;
    }

    let signed: Awaited<ReturnType<typeof gitSignFlow>>;
    try {
      signed = await gitSignFlow(
        { payload_base64: payload.toString('base64') },
        config,
        deps,
        context,
      );
    } catch (err) {
      if (err instanceof NoActiveSessionError) {
        return { status: 'rejected', reason: err.code };
      }
      throw err;
    }
    if (signed.status !== 'signed') {
      return { status: 'rejected', reason: signed.reason };
    }

    const signedPayload = insertGpgsigHeader(payload, signed.armored);
    const newSha = git(
      options.repoDir,
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      signedPayload,
    )
      .toString('utf8')
      .trim();
    mapping.set(sha, newSha);
    commits.push({ oldSha: sha, newSha, subject: subjectLine(payload) });
  }

  const newTip = mapping.get(oldTip);
  if (newTip === undefined) {
    return { status: 'rejected', reason: 'already_signed' };
  }

  // Compare-and-swap so a commit that raced in during wallet approval is
  // never clobbered. `update-ref HEAD` follows the symbolic ref to the
  // underlying branch (and works detached), so `ref` is passed as given.
  try {
    git(options.repoDir, ['update-ref', '-m', 'ac2 git-sign', ref, newTip, oldTip]);
  } catch (err) {
    return { status: 'rejected', reason: `git_error: ${(err as Error).message}` };
  }
  return { status: 'signed', ref, oldTip, newTip, commits };
}
