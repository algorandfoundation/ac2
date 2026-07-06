/**
 * Manifest contracts: re-exports `defineToolPlugin` + `getToolPluginMetadata`
 * from `openclaw/plugin-sdk/tool-plugin`, plus the plugin's own config schema
 * and lifecycle context types.
 */

import { Type, type Static } from '@sinclair/typebox';
import {
  defineToolPlugin,
  getToolPluginMetadata,
  type DefineToolPluginOptions,
  type DefinedToolPluginEntry,
  type ToolPluginExecutionContext,
  type ToolPluginMetadata,
  type ToolPluginToolDefinition,
} from 'openclaw/plugin-sdk/tool-plugin';

export {
  defineToolPlugin,
  getToolPluginMetadata,
  type DefineToolPluginOptions,
  type DefinedToolPluginEntry,
  type ToolPluginExecutionContext,
  type ToolPluginMetadata,
  type ToolPluginToolDefinition,
};

/** Context passed to a tool flow. */
export interface ToolContext {
  signal?: AbortSignal;
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
}

/** Channel-lifecycle seam consumed by `runAc2Channel`. */
export interface ChannelContext {
  signal?: AbortSignal;
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
  /** Called by the channel when a user message is received from the wallet. */
  receive: (text: string) => Promise<void>;
  /** Register a handler for when the agent produces output. */
  onOutput: (handler: (text: string) => Promise<void>) => void;
}

/** Plugin config schema (`PluginConfig`). */
export const ConfigSchema = Type.Object({
  liquidAuthServer: Type.Optional(
    Type.String({
      description:
        'Liquid Auth signaling server origin. Overridable via the `AC2_LIQUID_AUTH_SERVER` env var. Production deployments MUST set this; the bundled stub is for tests/demos only.',
    }),
  ),
  defaultTimeoutMs: Type.Optional(
    Type.Number({
      description: 'Default ceiling for awaiting pairing and SigningResponse, in milliseconds.',
      default: 120_000,
    }),
  ),
  x402MaxAmountAtomic: Type.Optional(
    Type.String({
      description:
        'Default maximum x402 payment amount, in asset atomic units. Defaults to 1000000 (1 USDC for 6-decimal USDC).',
      default: '1000000',
    }),
  ),
  x402AllowedNetworks: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Optional allow-list of x402 CAIP-2 Algorand networks. Defaults to Algorand TestNet and MainNet.',
    }),
  ),
  x402AllowedAssets: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Optional allow-list of x402 assets. Defaults to Algorand USDC asset identifiers and USDC.',
    }),
  ),
  x402AllowedPayTo: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Optional allow-list of x402 recipient Algorand addresses.',
    }),
  ),
  x402NetworkPreferences: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Preferred x402 Algorand networks when a resource offers multiple acceptable payment routes.',
    }),
  ),
  x402AlgodUrl: Type.Optional(
    Type.String({
      description:
        'Optional Algod URL override for constructing x402 Algorand payment transactions.',
    }),
  ),
  x402AlgodToken: Type.Optional(
    Type.String({
      description: 'Optional Algod API token used with x402AlgodUrl.',
    }),
  ),
});

export type PluginConfig = Static<typeof ConfigSchema>;
