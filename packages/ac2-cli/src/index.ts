/**
 * `@algorandfoundation/ac2-cli` programmatic barrel. Re-exports the identity,
 * keystore, session bootstrap, and control-protocol domains for embedded
 * consumers (e.g. the OpenClaw plugin) and tests.
 *
 * Both channel providers (`InMemoryChannelProvider`, `LiquidAuthChannelProvider`)
 * now live in `@algorandfoundation/ac2-sdk` — import them from
 * `@algorandfoundation/ac2-sdk/providers/in-memory` and
 * `@algorandfoundation/ac2-sdk/providers/liquid-auth` directly rather than
 * through this barrel, which no longer re-exports them.
 */

export * from './identity/index.js';
export * from './keystore/index.js';
export {
  BootstrapError,
  bootstrapAgentIdentity,
  deriveAgentDidFromKeyResponse,
} from './session/bootstrap.js';
export * from './control/index.js';
export {
  createConnectionBroker,
  type ConnectionBroker,
  type ConnectionBrokerOptions,
} from './daemon/broker.js';
export {
  AC2_DAEMON_VERSION,
  runDaemon,
  type DaemonRunOptions,
  type RunningDaemon,
} from './daemon/run.js';
export {
  daemonProcessStatus,
  followLogFile,
  isProcessAlive,
  readDaemonPid,
  startDetached,
  stopDaemonProcess,
  tailLogFile,
  type DaemonManagerOptions,
} from './daemon/manager.js';
export {
  installServiceUnit,
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveServiceUnitTarget,
  uninstallServiceUnit,
  type LaunchdOptions,
  type SystemdOptions,
} from './daemon/service-units.js';
