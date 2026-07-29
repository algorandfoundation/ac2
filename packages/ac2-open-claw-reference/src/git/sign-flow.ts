/**
 * Git commit/tag signing flow over AC2: build the SSHSIG signed-data blob
 * locally, ask the connected wallet for a raw Ed25519 signature via the
 * standard `signFlow`, then assemble the armored `SSH SIGNATURE` block that
 * `git` (and GitHub) verify.
 */

import { Buffer } from 'node:buffer';

import type { PluginConfig, ToolContext } from '../session/contracts.js';
import { signFlow, type SignDeps } from '../session/flows.js';
import {
  SSHSIG_NAMESPACE_GIT,
  assembleSshSigArmor,
  buildSshSigSignedData,
  parseAuthorizedKeyLine,
  toAuthorizedKeyLine,
  verifyEd25519,
} from './sshsig.js';

export const GIT_SIGN_SCHEMA = 'sshsig';
const SUBJECT_PREVIEW_LIMIT = 72;

export interface GitSignParams {
  /** Base64 of the raw git object bytes (commit/tag buffer git wants signed). */
  payload_base64: string;
  /** SSHSIG namespace; git always signs under `git`. */
  namespace?: string;
  /** Wallet-facing description; derived from the payload when omitted. */
  description?: string;
  /**
   * Expected signer key: an `ssh-ed25519 AAAA…` authorized-key line (git
   * `key::` literals accepted) or base64 of the raw 32-byte key. When set,
   * a wallet response signed by any other key is rejected.
   */
  expected_public_key?: string;
  expires_in_seconds?: number;
}

export type GitSignResult =
  | {
      status: 'signed';
      /** Armored `-----BEGIN SSH SIGNATURE-----` block for `<file>.sig`. */
      armored: string;
      /** Base64 raw 32-byte Ed25519 key that signed. */
      public_key: string;
      /** `ssh-ed25519 AAAA…` form of `public_key` (GitHub Signing Key format). */
      authorized_key: string;
      namespace: string;
      thid: string;
    }
  | {
      status: 'rejected';
      reason: string;
      thid?: string;
    };

/** Parse `expected_public_key` in either authorized-key-line or raw-base64 form. */
export function parseExpectedPublicKey(value: string): Buffer | undefined {
  const fromLine = parseAuthorizedKeyLine(value);
  if (fromLine) return fromLine;
  try {
    const raw = Buffer.from(value.trim(), 'base64');
    return raw.length === 32 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Human-readable summary of a git object buffer for the wallet approval
 * prompt: object kind plus the message subject line.
 */
export function describeGitPayload(payload: Buffer): string {
  const text = payload.toString('utf8');
  const kind = text.startsWith('tree ')
    ? 'git commit'
    : text.startsWith('object ')
      ? 'git tag'
      : 'git object';
  const separator = text.indexOf('\n\n');
  let subject = '';
  if (separator !== -1) {
    subject = (text.slice(separator + 2).split('\n')[0] ?? '').trim();
    if (subject.length > SUBJECT_PREVIEW_LIMIT) {
      subject = `${subject.slice(0, SUBJECT_PREVIEW_LIMIT - 1)}…`;
    }
  }
  return subject.length > 0 ? `Sign ${kind}: "${subject}"` : `Sign ${kind}`;
}

/** One SSHSIG signing round-trip on the active AC2 session. */
export async function gitSignFlow(
  params: GitSignParams,
  config: PluginConfig,
  deps: SignDeps = {},
  context: ToolContext = {},
): Promise<GitSignResult> {
  const namespace = params.namespace ?? SSHSIG_NAMESPACE_GIT;
  let payload: Buffer;
  try {
    payload = Buffer.from(params.payload_base64, 'base64');
  } catch {
    return { status: 'rejected', reason: 'invalid_payload_base64' };
  }
  if (payload.length === 0) {
    return { status: 'rejected', reason: 'empty_payload' };
  }

  let expectedKey: Buffer | undefined;
  if (params.expected_public_key !== undefined) {
    expectedKey = parseExpectedPublicKey(params.expected_public_key);
    if (!expectedKey) {
      return { status: 'rejected', reason: 'invalid_expected_public_key' };
    }
  }

  const signedData = buildSshSigSignedData(payload, namespace);
  const description = params.description ?? describeGitPayload(payload);

  const result = await signFlow(
    {
      description,
      payload_base64: signedData.toString('base64'),
      schema: GIT_SIGN_SCHEMA,
      sig_hint: 'raw-ed25519',
      display_hint: 'text',
      key_type: 'account',
      ...(params.expires_in_seconds !== undefined
        ? { expires_in_seconds: params.expires_in_seconds }
        : {}),
    },
    config,
    deps,
    context,
  );

  if (result.status === 'rejected') {
    return {
      status: 'rejected',
      reason: result.reason,
      ...(result.thid !== undefined ? { thid: result.thid } : {}),
    };
  }

  const publicKey = Buffer.from(result.public_key, 'base64');
  const signature = Buffer.from(result.signature, 'base64');
  if (publicKey.length !== 32 || signature.length !== 64) {
    return { status: 'rejected', reason: 'malformed_signing_response', thid: result.thid };
  }
  if (expectedKey && !expectedKey.equals(publicKey)) {
    return {
      status: 'rejected',
      reason:
        'public_key_mismatch: the wallet signed with a different key than the one configured ' +
        'as the git signing key — re-run `openclaw ac2 git-config` and update the key on GitHub.',
      thid: result.thid,
    };
  }
  if (!verifyEd25519(signedData, signature, publicKey)) {
    return { status: 'rejected', reason: 'invalid_signature', thid: result.thid };
  }

  return {
    status: 'signed',
    armored: assembleSshSigArmor(publicKey, signature, namespace),
    public_key: result.public_key,
    authorized_key: toAuthorizedKeyLine(publicKey),
    namespace,
    thid: result.thid,
  };
}
