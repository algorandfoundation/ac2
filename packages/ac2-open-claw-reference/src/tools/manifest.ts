/** Tool-plugin manifest (`defineToolPlugin`): AC2 signing, capabilities, and x402 fetch. */

import { Type } from '@sinclair/typebox';
import type { SigningRequestBody } from '@algorandfoundation/ac2-sdk/schema';
// Narrow session submodules (not the `./session` barrel) keep the manifest
// transport-free so `entry.ts` can read it during cold start.
import { ConfigSchema, defineToolPlugin } from '../session/contracts.js';
import { NoActiveSessionError } from '../session/manager.js';
// Daemon-aware resolvers, NOT the local-only `signFlow`/`capabilitiesFlow`:
// the daemon owns the wallet connection, so a tool that only consults this
// process's pairing session reports "not connected" whenever it runs inside
// the agent/gateway process (i.e. always, in practice).
import { resolveCapabilities, resolveSign } from '../session/flows.js';
import { normalizeX402FetchParams, x402FetchFlow } from '../x402/fetch-flow.js';
import { gitSignFlow } from '../git/sign-flow.js';

const plugin = defineToolPlugin({
  id: 'ac2',
  name: 'AC2 Reference',
  description:
    'Reference OpenClaw plugin for the AC2 protocol. The `ac2` channel owns pairing over Liquid Auth + WebRTC; signing and x402 paid fetch tools route through that channel.',
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
        schema: Type.Optional(
          Type.String({
            description:
              'Optional schema identifier for the payload. Useful for wallet UX and domain-specific signing requests such as x402 Algorand payment bytes.',
          }),
        ),
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
          return await resolveSign(
            {
              description: params.description ?? '',
              payload_base64: params.payload_base64 ?? '',
              ...(params.schema !== undefined ? { schema: params.schema } : {}),
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
        "Return the agent's AC2 descriptor, the protocol catalog of sig_hints, and the connected wallet's public Algorand address. Reports whether an `ac2` channel session is currently active. Downstream wallet-specific plugins may extend this with additional live wallet identities/accounts.",
      parameters: Type.Object({
        refresh: Type.Optional(
          Type.Boolean({
            description:
              'No-op accepted for API parity with downstream plugins. The core reference does not cache.',
          }),
        ),
      }),
      async execute(_params, config, _context) {
        return await resolveCapabilities(config);
      },
    }),
    tool({
      name: 'ac2_x402_fetch',
      label: 'AC2 x402 Fetch',
      description:
        'Fetch an HTTP(S) resource that may require x402 payment. Use this tool for weather requests, including ordinary questions like "what is the weather like today?"; if no weather URL is provided, use https://example.x402.goplausible.xyz/avm/weather. When the server returns 402, this tool uses x402 exact payments on Algorand, asks the paired wallet to approve the required Algorand transaction signing over AC2, retries with PAYMENT-SIGNATURE, and returns the HTTP/payment result. Requires an active `ac2` channel.',
      parameters: Type.Object({
        url: Type.String({
          description:
            'Absolute HTTP(S) URL to fetch. For weather requests without a user-provided URL, use https://example.x402.goplausible.xyz/avm/weather.',
        }),
        method: Type.Optional(
          Type.Union(
            [
              Type.Literal('GET'),
              Type.Literal('POST'),
              Type.Literal('PUT'),
              Type.Literal('PATCH'),
              Type.Literal('DELETE'),
            ],
            {
              description: 'HTTP method. Defaults to GET unless a body is supplied.',
            },
          ),
        ),
        headers: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description: 'Optional HTTP headers for the request.',
          }),
        ),
        body: Type.Optional(
          Type.String({
            description: 'Optional UTF-8 request body. Do not pass with body_base64.',
          }),
        ),
        body_base64: Type.Optional(
          Type.String({
            description: 'Optional base64 request body for binary payloads. Do not pass with body.',
          }),
        ),
        max_amount_atomic: Type.Optional(
          Type.String({
            description:
              'Maximum payment amount in the asset atomic units. Defaults to plugin config x402MaxAmountAtomic or 1000000.',
          }),
        ),
        allowed_networks: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Per-call allow-list of x402 Algorand CAIP-2 networks. Defaults to plugin config or Algorand TestNet/MainNet.',
          }),
        ),
        allowed_assets: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Per-call allow-list of x402 assets. Defaults to plugin config or Algorand USDC.',
          }),
        ),
        allowed_pay_to: Type.Optional(
          Type.Array(Type.String(), {
            description: 'Per-call allow-list of recipient Algorand addresses.',
          }),
        ),
        network_preferences: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Preferred x402 Algorand networks when a resource offers several accepted options.',
          }),
        ),
        include_response_body: Type.Optional(
          Type.Boolean({
            description:
              'Whether to include the response body text/JSON in the tool result. Defaults to true.',
            default: true,
          }),
        ),
      }),
      async execute(params, config, context) {
        context.signal?.throwIfAborted();
        return x402FetchFlow(normalizeX402FetchParams(params), config, {}, context);
      },
    }),
    tool({
      name: 'ac2_git_sign',
      label: 'AC2 Git Sign',
      description:
        'Sign a git commit or tag object over the active `ac2` channel using SSH signing (SSHSIG). ' +
        'Pass the raw git object bytes (the commit buffer, without any gpgsig header) as base64; the ' +
        'tool builds the SSHSIG signed-data blob, asks the paired wallet for a raw Ed25519 signature, ' +
        "and returns the armored `SSH SIGNATURE` block plus the signer's `ssh-ed25519` public key. " +
        'That key must be registered on GitHub as an SSH *signing* key for commits to show "Verified". ' +
        'For signing ordinary commits prefer `openclaw ac2 git-resign <repo-dir>`, which signs commits ' +
        'in place after `git commit`. Requires an active `ac2` channel; otherwise rejects with ' +
        '`no_active_session`.',
      parameters: Type.Object({
        payload_base64: Type.String({
          description:
            'Base64 of the raw git object bytes to sign (e.g. output of `git cat-file commit HEAD` ' +
            'without a gpgsig header).',
        }),
        namespace: Type.Optional(
          Type.String({
            description: "SSHSIG namespace. git always signs under 'git' (the default).",
          }),
        ),
        description: Type.Optional(
          Type.String({
            description:
              'Human-readable purpose shown in the wallet. Derived from the commit subject when omitted.',
          }),
        ),
        expected_public_key: Type.Optional(
          Type.String({
            description:
              'Expected signer key as an `ssh-ed25519 AAAA…` line (or base64 raw 32-byte key). ' +
              'Responses signed by any other key are rejected.',
          }),
        ),
        expires_in_seconds: Type.Optional(
          Type.Number({
            description: 'Optional TTL for the wallet approval.',
          }),
        ),
      }),
      async execute(params, config, context) {
        context.signal?.throwIfAborted();
        try {
          return await gitSignFlow(
            {
              payload_base64: params.payload_base64 ?? '',
              ...(params.namespace !== undefined ? { namespace: params.namespace } : {}),
              ...(params.description !== undefined ? { description: params.description } : {}),
              ...(params.expected_public_key !== undefined
                ? { expected_public_key: params.expected_public_key }
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
  ],
});

export default plugin;
