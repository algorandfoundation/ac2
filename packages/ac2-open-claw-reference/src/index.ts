/**
 * `@ac2/ac2-open-claw-reference` programmatic barrel. The OpenClaw host entry
 * lives in `./entry.js`; this module re-exports it alongside the session,
 * channel, tool, and CLI domains for tests and embedded consumers.
 *
 * The connection layer (Liquid Auth / in-memory providers, identity + keystore
 * persistence, wallet bootstrap) lives in `@algorandfoundation/ac2-cli` and is
 * imported from there directly — this barrel deliberately does not re-export it.
 */

export {
  signFlow,
  capabilitiesFlow,
  resolveSign,
  resolveCapabilities,
  resolveWalletAccount,
  defineToolPlugin,
  getToolPluginMetadata,
  SessionManager,
  NoActiveSessionError,
  sessionManager,
  type SignParams,
  type SignResult,
  type SignDeps,
  type ResolveSignDeps,
  type ResolveCapabilitiesDeps,
  type ResolveWalletAccountDeps,
  type ResolvedWalletAccount,
  type ActiveSession,
  type CapabilitiesResult,
  type ToolContext,
  type DefineToolPluginOptions,
  type DefinedToolPluginEntry,
  type ToolPluginExecutionContext,
  type ToolPluginMetadata,
  type ToolPluginToolDefinition,
} from './session/index.js';
export {
  buildChannelObject,
  AC2_MEDIA_SOURCE_PARAMS,
  getActiveConversation,
  resolveAc2SessionConversation,
  resolveAc2OutboundSessionRoute,
  buildAc2SessionKey,
  DEFAULT_THID,
  type Ac2MediaSourceParams,
  type Ac2SessionConversation,
  type Ac2OutboundSessionRoute,
} from './channel/index.js';
export { buildAc2Command, renderPairingQr, renderPairingQr as renderQr } from './cli/index.js';
export {
  buildSignTool,
  buildCapabilitiesTool,
  buildX402FetchTool,
  buildGitSignTool,
} from './tools/index.js';
export {
  SSHSIG_NAMESPACE_GIT,
  assembleSshSigArmor,
  buildSshSigSignedData,
  decodeSshSigArmor,
  encodeSshEd25519PublicKey,
  parseAuthorizedKeyLine,
  toAuthorizedKeyLine,
  verifyEd25519,
  GIT_SIGN_SCHEMA,
  describeGitPayload,
  gitSignFlow,
  parseExpectedPublicKey,
  insertGpgsigHeader,
  resignCommits,
  rewriteParentHeaders,
  stripGpgsigHeader,
  resolveAc2StateDir,
  type DecodedSshSig,
  type GitSignParams,
  type GitSignResult,
  type GitResignOptions,
  type GitResignResult,
} from './git/index.js';
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
