/** Identity bootstrap: ask the wallet for an Ed25519 key via `KeyRequest`. */

import type { Ac2Client } from '@algorandfoundation/ac2-sdk';
import type { AC2KeyResponse as KeyResponseMessage } from '@algorandfoundation/ac2-sdk/schema';
import { normalizeDidKey } from '../identity/did.js';

/** Anonymous `from` for the bootstrap request (agent has no identity yet). */
const BOOTSTRAP_PLACEHOLDER_DID = 'did:key:zAc2Bootstrap';

/** Derive a canonical `did:key:z…` from a `KeyResponse`. */
export function deriveAgentDidFromKeyResponse(response: KeyResponseMessage): string {
  return normalizeDidKey(`did:key:${response.body.public_key}`);
}

/** Raised when the post-pairing key bootstrap fails. */
export class BootstrapError extends Error {
  readonly code = 'bootstrap_failed' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'BootstrapError';
    if (options?.cause !== undefined) (this as any).cause = options.cause;
  }
}

/** Run the bootstrap `KeyRequest` and return the derived `agentDid` + `controllerDid`. */
export async function bootstrapAgentIdentity(
  client: Ac2Client,
  opts: { peerDid?: string; timeoutMs?: number } = {},
): Promise<{ agentDid: string; controllerDid: string; response: KeyResponseMessage }> {
  const to = opts.peerDid ?? 'did:key:zAc2Controller';
  const timeoutOpts = opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {};
  let response: KeyResponseMessage;
  try {
    response = await client.requestKey(
      {
        from: BOOTSTRAP_PLACEHOLDER_DID,
        to,
        body: {
          key_type: 'ed25519',
          purpose: ['sign', 'verify'],
          for_operation: 'ac2/identity',
        },
      },
      timeoutOpts,
    );
  } catch (err) {
    throw new BootstrapError(
      `[ac2-open-claw] bootstrap KeyRequest failed: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (response.body.status !== 'approved') {
    throw new BootstrapError(
      `[ac2-open-claw] wallet rejected bootstrap KeyRequest: ${response.body.reason ?? 'no reason given'}`,
    );
  }
  return {
    agentDid: deriveAgentDidFromKeyResponse(response),
    controllerDid: normalizeDidKey(response.from),
    response,
  };
}
