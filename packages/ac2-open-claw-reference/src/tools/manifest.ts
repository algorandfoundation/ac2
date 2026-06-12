/** Tool-plugin manifest (`defineToolPlugin`): `ac2_sign` + `ac2_capabilities`. */

import { Type } from '@sinclair/typebox';
import type { SigningRequestBody } from '@algorandfoundation/ac2-sdk/schema';
// Narrow session submodules (not the `./session` barrel) keep the manifest
// transport-free so `entry.ts` can read it during cold start.
import { ConfigSchema, defineToolPlugin } from '../session/contracts.js';
import { NoActiveSessionError } from '../session/manager.js';
import { capabilitiesFlow, signFlow } from '../session/flows.js';

const plugin = defineToolPlugin({
  id: 'ac2-open-claw-reference',
  name: 'AC2 Reference',
  description:
    'Reference OpenClaw plugin for the AC2 protocol. The `ac2` channel owns pairing over Liquid Auth + WebRTC; the `ac2_sign` and `ac2_capabilities` tools route through that channel.',
  configSchema: ConfigSchema,
  tools: (tool) => [
    tool({
      name: 'ac2_sign',
      label: 'AC2 Sign',
      description:
        'Ask the user\'s connected wallet (over the active `ac2` channel) to sign the supplied base64 payload. Returns `{ status: "signed", signature, public_key, ... }` on approval or `{ status: "rejected", reason }` on decline. Requires an active `ac2` channel; otherwise rejects with `no_active_session`.',
      parameters: Type.Object({
        description: Type.String({
          description:
            'Human-readable purpose shown to the user in the wallet. REQUIRED by the AC2 spec — vague descriptions get declined.',
        }),
        payload_base64: Type.String({
          description:
            'Base64-encoded raw bytes the wallet will sign. The core reference signs these bytes as-is under the selected curve; downstream plugins may apply additional encodings based on `sig_hint`.',
        }),
        sig_hint: Type.Optional(
          Type.String({
            description:
              "AC2 sig_hint identifying the curve to use: 'raw-ed25519' or 'raw-secp256k1'. Strongly recommended — omitting it falls back to plain Ed25519 over raw bytes. Downstream wallet plugins may accept additional, chain-specific hints.",
          }),
        ),
        display_hint: Type.Optional(
          Type.String({
            description:
              "How the wallet should preview the payload to the user: 'text' | 'json' | 'hex'.",
          }),
        ),
        key_type: Type.Optional(
          Type.String({
            description:
              "Which key role to use: 'account' (on-chain, default) | 'identity' (DID-bound, for sign-in/attestations).",
          }),
        ),
        expires_in_seconds: Type.Optional(
          Type.Number({
            description:
              'Optional TTL for the request. The wallet MUST reject responses received after this time.',
          }),
        ),
      }),
      async execute(params, config, context) {
        context.signal?.throwIfAborted();
        try {
          return await signFlow(
            {
              description: params.description ?? '',
              payload_base64: params.payload_base64 ?? '',
              ...(params.sig_hint !== undefined
                ? { sig_hint: params.sig_hint as SigningRequestBody['sig_hint'] }
                : {}),
              ...(params.display_hint !== undefined
                ? {
                    display_hint: params.display_hint as SigningRequestBody['display_hint'],
                  }
                : {}),
              ...(params.key_type !== undefined
                ? { key_type: params.key_type as SigningRequestBody['key_type'] }
                : {}),
              ...(params.expires_in_seconds !== undefined
                ? { expires_in_seconds: params.expires_in_seconds }
                : {}),
            },
            config,
            {},
            context,
          );
        } catch (err) {
          if (err instanceof NoActiveSessionError) {
            return {
              status: 'rejected' as const,
              reason: err.code,
            };
          }
          throw err;
        }
      },
    }),
    tool({
      name: 'ac2_capabilities',
      label: 'AC2 Capabilities',
      description:
        "Return the agent's AC2 descriptor and the protocol catalog of sig_hints. Reports whether an `ac2` channel session is currently active. Downstream wallet-specific plugins extend this with live wallet identities/accounts.",
      parameters: Type.Object({
        refresh: Type.Optional(
          Type.Boolean({
            description:
              'No-op accepted for API parity with downstream plugins. The core reference does not cache.',
          }),
        ),
      }),
      async execute(_params, config, _context) {
        return capabilitiesFlow(config);
      },
    }),
  ],
});

export default plugin;
