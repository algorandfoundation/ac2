/** Session domain: plugin contracts, the session manager, bootstrap, and flows. */

export {
  defineToolPlugin,
  getToolPluginMetadata,
  ConfigSchema,
  type PluginConfig,
  type ToolContext,
  type ChannelContext,
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
  BootstrapError,
  bootstrapAgentIdentity,
  deriveAgentDidFromKeyResponse,
} from './bootstrap.js';
export {
  buildFinalizeFrame,
  signFlow,
  capabilitiesFlow,
  type SignParams,
  type SignResult,
  type SignDeps,
  type CapabilitiesResult,
} from './flows.js';
export { runAc2Channel, renderPairingQr, type ChannelDeps } from './channel-runtime.js';
export { runConnectedSession, type ConnectedSessionOptions } from './connected-session.js';
export {
  Ac2ConnectionSupervisor,
  connectionSupervisor,
  isPairingAuthorizationError,
  reconnectDelayMs,
  type Ac2SupervisorOptions,
  type Ac2SupervisorState,
  type Ac2SupervisorStatus,
} from './supervisor.js';
