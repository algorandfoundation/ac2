/**
 * Session domain: plugin contracts, the session manager, and flows.
 *
 * Wallet identity bootstrap now lives in `@algorandfoundation/ac2-cli`
 * (`@algorandfoundation/ac2-cli/session/bootstrap`).
 */

export {
  defineToolPlugin,
  getToolPluginMetadata,
  ConfigSchema,
  type PluginConfig,
  type ToolContext,
  type DefineToolPluginOptions,
  type DefinedToolPluginEntry,
  type ToolPluginExecutionContext,
  type ToolPluginMetadata,
  type ToolPluginToolDefinition,
} from './contracts.js';
export {
  SessionManager,
  NoActiveSessionError,
  sessionManager,
  type ActiveSession,
} from './manager.js';
export {
  controllerDidToAlgorandAddress,
  sessionAlgorandAddress,
  walletAccountAlgorandAddress,
  type WalletAccountFacts,
} from './wallet-address.js';
// `signFlow`/`capabilitiesFlow` act on an in-process pairing session only; the
// `resolve*` variants also consult the daemon that owns the wallet connection
// and are what the tools use.
export {
  buildFinalizeFrame,
  signFlow,
  capabilitiesFlow,
  capabilitiesFromDaemon,
  resolveCapabilities,
  signViaDaemon,
  resolveSign,
  resolveWalletAccount,
  type SignParams,
  type SignResult,
  type SignDeps,
  type CapabilitiesResult,
  type DaemonCapabilitiesDeps,
  type ResolveCapabilitiesDeps,
  type SignViaDaemonDeps,
  type ResolveSignDeps,
  type ResolveWalletAccountDeps,
  type ResolvedWalletAccount,
} from './flows.js';
