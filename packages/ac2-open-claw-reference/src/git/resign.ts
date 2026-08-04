/**
 * Sign-after-commit ("resign") flow — how AC2 git signing works: commits are
 * created unsigned by plain `git commit` and then rewritten in place:
 *
 *   1. `git cat-file commit <sha>` — the exact raw payload SSHSIG signs
 *      (an unsigned commit's content IS the signed-data input),
 *   2. the wallet signs it via the ordinary in-process {@link gitSignFlow},
 *   3. the armored block is inserted as a `gpgsig` header and the new object
 *      written with `git hash-object`, and the ref moved with a
 *      compare-and-swap `git update-ref`.
 *
 * Because this runs inside the process that holds the active AC2 session,
 * no git-side signing configuration is needed. The trade-offs: commits
 * exist unsigned until re-signed, signing before push is enforced by the
 * skill instructions rather than by git itself (`commit.gpgsign` stays
 * off), and rewriting a parent changes every descendant hash — so ranges
 * are re-signed oldest first with parent headers rewritten along the way.
 */

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';

import type { PluginConfig, ToolContext } from '../session/contracts.js';
import type { SignDeps } from '../session/flows.js';
import { NoActiveSessionError } from '../session/manager.js';
import { gitSignFlow } from './sign-flow.js';

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
 * continuation lines). The result is the exact payload the signature covers.
 */
export function stripGpgsigHeader(payload: Buffer): { payload: Buffer; hadSignature: boolean } {
  const { headerLines, message } = splitHeaders(payload);
  const kept: string[] = [];
  let inSignature = false;
  let hadSignature = false;
  for (const line of headerLines) {
    if (isGpgsigStart(line)) {
      inSignature = true;
      hadSignature = true;
      continue;
    }
    if (inSignature && line.startsWith(' ')) continue;
    inSignature = false;
    kept.push(line);
  }
  if (!hadSignature) return { payload, hadSignature: false };
  return { payload: joinHeaders(kept, message), hadSignature: true };
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

/** Rewrite `parent <sha>` headers through an old→new mapping (chain re-sign). */
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

/** Message subject line, for per-commit reporting. */
function commitSubject(payload: Buffer): string {
  const separator = payload.indexOf('\n\n');
  if (separator === -1) return '';
  return (payload.subarray(separator + 2).toString('utf8').split('\n')[0] ?? '').trim();
}

export interface GitResignOptions {
  /** Absolute path to the git repository. */
  repoDir: string;
  /** Ref whose tip to re-sign; defaults to `HEAD`. */
  ref?: string;
  /**
   * When set, re-sign every commit in `base..ref` (oldest first), rewriting
   * parent hashes along the chain. Without it only the tip commit is signed.
   */
  base?: string;
}

export type GitResignResult =
  | {
      status: 'signed';
      ref: string;
      oldTip: string;
      newTip: string;
      /** Old→new sha per re-signed commit, oldest first. */
      commits: Array<{ oldSha: string; newSha: string; subject: string }>;
    }
  | { status: 'rejected'; reason: string };

/**
 * Re-sign the commit(s) at `ref` via the active AC2 session and move the ref
 * to the rewritten tip. One wallet approval per commit; a rejection aborts
 * before any ref is touched (loose objects already written are harmless).
 */
export async function resignCommits(
  options: GitResignOptions,
  config: PluginConfig,
  deps: SignDeps = {},
  context: ToolContext = {},
): Promise<GitResignResult> {
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

  const mapping = new Map<string, string>();
  const commits: Array<{ oldSha: string; newSha: string; subject: string }> = [];
  for (const sha of shas) {
    const raw = git(options.repoDir, ['cat-file', 'commit', sha]);
    const withParents = rewriteParentHeaders(raw, mapping);
    const { payload, hadSignature } = stripGpgsigHeader(withParents);
    if (hadSignature && withParents === raw) {
      // Already signed and its parents are untouched: nothing to redo.
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

    const resigned = insertGpgsigHeader(payload, signed.armored);
    const newSha = git(options.repoDir, ['hash-object', '-t', 'commit', '-w', '--stdin'], resigned)
      .toString('utf8')
      .trim();
    mapping.set(sha, newSha);
    commits.push({ oldSha: sha, newSha, subject: commitSubject(payload) });
  }

  const newTip = mapping.get(oldTip);
  if (newTip === undefined) {
    return { status: 'rejected', reason: 'already_signed' };
  }

  // Compare-and-swap so a commit that raced in during wallet approval is
  // never clobbered. `update-ref HEAD` follows the symbolic ref to the
  // underlying branch (and works detached), so `ref` is passed as given.
  try {
    git(options.repoDir, ['update-ref', '-m', 'ac2 git-resign', ref, newTip, oldTip]);
  } catch (err) {
    return { status: 'rejected', reason: `git_error: ${(err as Error).message}` };
  }
  return { status: 'signed', ref, oldTip, newTip, commits };
}
