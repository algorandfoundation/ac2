/**
 * `@ac2/ac2-open-claw-reference` programmatic barrel. The OpenClaw host entry
 * lives in `./entry.js`; this module re-exports it alongside the session,
 * channel, tool, CLI, and provider domains for tests and embedded consumers.
 */

export {
  signFlow,
  capabilitiesFlow,
  runAc2Channel,
  renderPairingQr,
  renderPairingQr as renderQr,
  defineToolPlugin,
  getToolPluginMetadata,
  SessionManager,
  NoActiveSessionError,
  BootstrapError,
  bootstrapAgentIdentity,
  sessionManager,
  Ac2ConnectionSupervisor,
  connectionSupervisor,
  isPairingAuthorizationError,
  reconnectDelayMs,
  type SignParams,
  type SignResult,
  type SignDeps,
  type ChannelDeps,
  type ActiveSession,
  type Ac2SupervisorOptions,
  type Ac2SupervisorState,
  type Ac2SupervisorStatus,
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
export { buildSignTool, buildCapabilitiesTool, buildX402FetchTool } from './tools/index.js';
export {
  X402_ALGORAND_SIGNING_SCHEMA,
  X402ControllerAddressError,
  X402SigningRejectedError,
  classifyX402SigningError,
  controllerDidToAlgorandAddress,
  createAc2AvmSigner,
  normalizeX402FetchParams,
  x402FetchFlow,
  type Ac2AvmSignerOptions,
  type X402FetchParams,
  type X402FetchResult,
  type X402PaymentContext,
  type X402PaymentSelection,
} from './x402/index.js';
export {
  awaitSignalConnect,
  createPairingInvitation,
  getLiquidAuthPairingErrorCode,
  revokePairing,
  isLiquidAuthPairingCredential,
  LiquidAuthPairingError,
  SignalingConnectError,
  withSignalingHealthGuard,
  type LiquidAuthChannelProviderOptions,
  type LiquidAuthPairingErrorCode,
  type LiquidAuthPairingCredential,
} from './providers/liquid-auth.js';
export async function loadLiquidAuthChannelProvider(): Promise<
  typeof import('./providers/liquid-auth.js')
> {
  return import('./providers/liquid-auth.js');
}
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
