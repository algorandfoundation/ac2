/** Transport-free AC2 flows: `signFlow`, `capabilitiesFlow`, `buildFinalizeFrame`. */

import type { BuildSigningRequestArgs, SigningOutcome } from '@algorandfoundation/ac2-sdk/protocol';
import type { SigningRequestBody } from '@algorandfoundation/ac2-sdk/schema';
import type { PluginConfig, ToolContext } from './contracts.js';
import { SessionManager, sessionManager } from './manager.js';

const STREAM_CONTROL_PREFIX = '\u0002';

/** Build a `finalize` stream control frame. */
export function buildFinalizeFrame(text: string, thid = 'default'): string {
  return (
    STREAM_CONTROL_PREFIX + JSON.stringify({ t: 'finalize', thid, mid: `ac2-${Date.now()}`, text })
  );
}

export interface SignParams {
  description: string;
  payload_base64: string;
  sig_hint?: SigningRequestBody['sig_hint'];
  display_hint?: SigningRequestBody['display_hint'];
  key_type?: SigningRequestBody['key_type'];
  expires_in_seconds?: number;
}

export type SignResult =
  | {
      status: 'signed';
      signature: string;
      public_key: string;
      address?: string;
      key_type?: 'account' | 'identity';
      thid: string;
    }
  | {
      status: 'rejected';
      reason: string;
      thid?: string;
    };

export interface SignDeps {
  manager?: SessionManager;
}

/** One `SigningRequest` round-trip on the active session. */
export async function signFlow(
  params: SignParams,
  config: PluginConfig,
  deps: SignDeps = {},
  context: ToolContext = {},
): Promise<SignResult> {
  const manager = deps.manager ?? sessionManager;
  const active = manager.requireActive();
  context.signal?.throwIfAborted();

  if (active.identityGranted === false) {
    return {
      status: 'rejected',
      reason: 'no_identity',
    };
  }

  const args: BuildSigningRequestArgs = {
    from: active.agentDid,
    to: active.controllerDid,
    body: {
      description: params.description,
      encoding: 'base64',
      payload: params.payload_base64,
      ...(params.sig_hint !== undefined ? { sig_hint: params.sig_hint } : {}),
      ...(params.display_hint !== undefined ? { display_hint: params.display_hint } : {}),
      ...(params.key_type !== undefined ? { key_type: params.key_type } : {}),
    },
    ...(params.expires_in_seconds !== undefined
      ? {
          expires_time: Math.floor(Date.now() / 1000) + params.expires_in_seconds,
        }
      : {}),
  };

  const outcome: SigningOutcome = await active.client.requestSignature(args, {
    timeoutMs: config.defaultTimeoutMs ?? 120_000,
  });

  if (outcome.kind === 'rejected') {
    return {
      status: 'rejected',
      reason: outcome.message.body.reason,
      ...(outcome.message.thid !== undefined ? { thid: outcome.message.thid } : {}),
    };
  }
  const body = outcome.message.body;
  const thid = outcome.message.thid ?? '';
  return {
    status: 'signed',
    signature: body.signature,
    public_key: body.public_key,
    ...(body.address !== undefined ? { address: body.address } : {}),
    ...(body.key_type !== undefined ? { key_type: body.key_type } : {}),
    thid,
  };
}

export interface CapabilitiesResult {
  status: 'ok' | 'no_active_session';
  agent: {
    /** Agent DID, populated once an `ac2` session is active; `null` before. */
    did: string | null;
    plugin: { id: string; version: string };
    sigHintsCatalog: ReadonlyArray<SigningRequestBody['sig_hint']>;
  };
  session: {
    connected: boolean;
    /** Connected controller account, populated once a session is active. */
    controllerDid: string | null;
  };
}

const SIG_HINTS_CATALOG = ['raw-ed25519', 'raw-secp256k1'] as const;

export function capabilitiesFlow(_config: PluginConfig, deps: SignDeps = {}): CapabilitiesResult {
  const manager = deps.manager ?? sessionManager;
  const active = manager.getActive();
  const hasIdentity = active != null && active.identityGranted !== false;
  return {
    status: active ? 'ok' : 'no_active_session',
    agent: {
      did: hasIdentity ? active.agentDid : null,
      plugin: { id: 'ac2-open-claw-reference', version: '0.1.0' },
      sigHintsCatalog: SIG_HINTS_CATALOG as unknown as ReadonlyArray<
        SigningRequestBody['sig_hint']
      >,
    },
    session: { connected: active !== null, controllerDid: active?.controllerDid ?? null },
  };
}
