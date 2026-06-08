/**
 * `@ac2/ac2-open-claw-reference` programmatic barrel. The OpenClaw host entry
 * lives in `./entry.js`; this module re-exports it alongside the session,
 * channel, tool, CLI, and provider domains for tests and embedded consumers.
 */

export {
  signFlow,
  capabilitiesFlow,
  runAc2Channel,
  defineToolPlugin,
  getToolPluginMetadata,
  SessionManager,
  NoActiveSessionError,
  BootstrapError,
  bootstrapAgentIdentity,
  sessionManager,
  type SignParams,
  type SignResult,
  type SignDeps,
  type ChannelDeps,
  type ActiveSession,
  type CapabilitiesResult,
  type ToolContext,
  type ChannelContext,
  type DefineToolPluginOptions,
  type DefinedToolPluginEntry,
  type ToolPluginExecutionContext,
  type ToolPluginMetadata,
  type ToolPluginToolDefinition,
} from './session/index.js';
export {
  buildChannelObject,
  AC2_MEDIA_SOURCE_PARAMS,
  setActiveConversation,
  clearActiveConversation,
  resolveAc2SessionConversation,
  resolveAc2OutboundSessionRoute,
  replayConversationList,
  replayConversationHistory,
  type Ac2MediaSourceParams,
  type Ac2SessionConversation,
  type Ac2OutboundSessionRoute,
} from './channel/index.js';
export { buildAc2Command } from './cli/index.js';
export { buildSignTool, buildCapabilitiesTool } from './tools/index.js';
export {
  LiquidAuthChannelProvider,
  renderPairingQr,
  renderPairingQr as renderQr,
  type LiquidAuthChannelProviderOptions,
} from './providers/liquid-auth.js';
export {
  InMemoryChannelProvider,
  type InMemoryChannelProviderOptions,
} from './providers/in-memory.js';
export type {
  Ac2ChannelProvider,
  Ac2PairedChannel,
  Ac2PairingHandle,
  Ac2PairingInfo,
  Ac2StartPairingOptions,
} from '@algorandfoundation/ac2-sdk/signaling';

export { default, pluginEntry, register, activate, id } from './entry.js';
export { default as pluginManifest } from './tools/manifest.js';
export { CHANNEL_ID } from './runtime.js';
