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
});

export type PluginConfig = Static<typeof ConfigSchema>;
