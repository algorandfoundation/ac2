/**
 * Runtime-adapter contract for the AC2 daemon.
 *
 * The daemon (`@algorandfoundation/ac2-cli`) owns exactly one thing well:
 * the wallet connection (Liquid Auth pairing, the WebRTC channel, identity
 * persistence). What happens to inbound wallet frames — and where outbound
 * frames come from — is a separate concern, and this module is the seam
 * between the two: a **runtime adapter** plugs an agent runtime into the
 * daemon without the daemon knowing anything about that runtime's
 * implementation, and without the adapter knowing anything about Liquid
 * Auth, WebRTC, or the control socket.
 *
 * Adapters are **loadable**: this contract lives in the SDK (a runtime
 * dependency free of any daemon internals) so a third party can publish an
 * npm package exporting {@link CreateRuntimeAdapter} and the daemon resolves
 * it at runtime by package specifier — see `@algorandfoundation/ac2-cli`'s
 * `loadRuntimeAdapter`. The daemon's pre-existing behaviour (routing wallet
 * traffic to a control-socket-registered agent) is itself just the built-in
 * `socket` adapter, so a daemon with nothing configured behaves exactly as
 * it always has.
 *
 * ## Lifecycle
 *
 * The daemon drives an adapter's hooks in this order, all of them optional
 * except {@link Ac2RuntimeAdapter.handleInbound}:
 *
 * 1. `start()` — once, right after the adapter is constructed (before any
 *    wallet ever pairs). Use this for one-time setup (e.g. opening a
 *    connection to an external agent process).
 * 2. `onConnected(info)` — every time the wallet channel opens, including
 *    reconnects, with a fresh {@link Ac2RuntimeConnectionInfo} snapshot.
 * 3. `handleInbound(message)` — once per inbound wallet frame, for as long
 *    as the connection stays open and un-{@link Ac2RuntimeConnectionInfo.locked
 *    | locked}.
 * 4. `onDisconnected(reason)` — when the wallet channel drops. The daemon
 *    may reconnect afterwards, in which case `onConnected` fires again.
 * 5. `stop()` — once, when the daemon itself is shutting down.
 *
 * Steps 2–4 can repeat any number of times across the adapter's lifetime
 * (the wallet can pair, drop, and re-pair repeatedly); only `start()` and
 * `stop()` are guaranteed to fire exactly once each.
 *
 * ### The `locked` rule
 *
 * {@link Ac2RuntimeConnectionInfo.locked} is `true` when the daemon refused
 * the connecting wallet because it is already bound to a different
 * controller. While `locked`:
 *
 * - `onConnected` still fires (with `locked: true`), so an adapter can
 *   surface the refusal in its own UX if it wants to.
 * - `handleInbound` is **never** called — the daemon drops inbound wallet
 *   traffic entirely while locked.
 * - {@link Ac2RuntimeHost.send} still works — a locked adapter can still
 *   push an outbound frame (e.g. "you are not registered") to the wallet.
 *
 * An adapter author only needs the types in this module to implement
 * correctly: nothing about pairing, transports, or the control socket leaks
 * through this seam.
 *
 * ### Fault isolation
 *
 * A hook that throws (synchronously or via a rejected promise) is caught
 * and logged by the daemon; it must never tear down the wallet connection
 * or the daemon process. Likewise, a failure to *load* an adapter (missing
 * package, wrong export, bad returned shape) never crashes the daemon — it
 * just runs with no adapter attached. See `loadRuntimeAdapter` in
 * `@algorandfoundation/ac2-cli` for the loader side of that contract.
 */

/**
 * One inbound wallet frame, handed to {@link Ac2RuntimeAdapter.handleInbound}.
 *
 * Deliberately does not carry the target agent id: an adapter is
 * constructed for exactly one agent (see {@link Ac2RuntimeHost.agent}), so
 * there is nothing to route.
 */
export interface Ac2RuntimeInbound {
  /** Which wallet channel the frame arrived on. */
  channel: 'control' | 'stream';
  /** The raw frame payload, exactly as the wallet sent it. */
  payload: string;
  /** The wallet controller's `did:key`, when known. */
  controllerDid: string | null;
  /** The active connection's `requestId`, when known. */
  requestId: string | null;
}

/**
 * Snapshot of the wallet connection, handed to
 * {@link Ac2RuntimeAdapter.onConnected}.
 *
 * WHY DUPLICATED, NOT IMPORTED: this mirrors
 * `ControlEvents['connection.connected']` in
 * `@algorandfoundation/ac2-cli/control/protocol.js` field-for-field. The SDK
 * cannot import that type without creating a dependency from the SDK onto
 * the CLI (the dependency direction is the other way around), so the shape
 * is duplicated here instead. `packages/ac2-cli/src/runtime/loader.ts`
 * carries a compile-time assertion pinning this type against
 * `ControlEvents['connection.connected']`, so the two cannot silently drift
 * — a change to one without the other fails `tsc --noEmit` on the CLI.
 */
export interface Ac2RuntimeConnectionInfo {
  /** The active connection's identifier. */
  requestId: string;
  /** The wallet controller's `did:key`, when known. */
  controllerDid: string | null;
  /** The connected wallet's account address, when known. */
  walletAddress: string | null;
  /** Wallet-issued DID for the target agent, when {@link identityGranted}. */
  agentDid: string | null;
  /** `true` when a usable agent identity exists for this session. */
  identityGranted: boolean;
  /**
   * `true` when the daemon refused this wallet because it is already bound
   * to a different controller. See the module-level "The `locked` rule"
   * section above for what this means for {@link Ac2RuntimeAdapter}.
   */
  locked: boolean;
}

/**
 * What the daemon gives an adapter to act on the wallet connection. The
 * daemon constructs exactly one host per adapter instance, scoped to the
 * single agent id the adapter was loaded for.
 */
export interface Ac2RuntimeHost {
  /**
   * Send an outbound frame to the connected wallet. Resolves `true` once
   * delivered, `false` if there is currently no open channel to deliver on
   * (never rejects). Works even while the connection is
   * {@link Ac2RuntimeConnectionInfo.locked | locked} — see the module-level
   * "The `locked` rule" section above.
   */
  send(payload: string, channel?: 'control' | 'stream'): Promise<boolean>;
  /** Append a line to the daemon's log (already timestamped by the daemon). */
  log(line: string): void;
  /**
   * Signal that this adapter's agent runtime is now ALIVE — e.g. the
   * gateway WebSocket handshake completed, or an external agent process
   * finished starting up. The daemon uses the FIRST such signal to decide
   * it is safe to start awaiting a wallet: until at least one runtime is
   * alive it does not arm pairing/resume, so a wallet is never left talking
   * to a service that has no agent behind it (see
   * {@link Ac2RuntimeAdapter.managesOwnReadiness}). Idempotent from the
   * daemon's side — safe to call more than once (e.g. on every gateway
   * reconnect); only the first call has an effect.
   *
   * Optional: a `socket`-style adapter whose liveness the daemon can already
   * observe directly (a control-socket `agent.hello`) does not need to call
   * this — see {@link Ac2RuntimeAdapter.managesOwnReadiness}.
   */
  reportRuntimeReady?(): void;
  /** The agent id this host — and therefore this adapter instance — is scoped to. */
  readonly agent: string;
  /** The daemon's own `did:key`, once generated; `null` beforehand. */
  readonly serviceDid: string | null;
}

/**
 * A conversation (thread) lifecycle announcement made by the wallet
 * controller, handed to {@link Ac2RuntimeAdapter.onConversation}.
 *
 * WHY THIS IS A HOOK OF ITS OWN: the wallet announces "I opened / switched to
 * thread X" as an AC2 protocol message (`ac2/ConversationOpen` /
 * `ac2/ConversationClose`), which the daemon's own `Ac2Client` consumes — it
 * therefore never reaches {@link Ac2RuntimeAdapter.handleInbound} (that only
 * sees raw, non-AC2 chat frames). Without this hook an adapter cannot know
 * which thread the user is looking at, so its live activity indicators and
 * history replay would always target the default thread.
 */
export interface Ac2RuntimeConversationEvent {
  /** `'open'` when the wallet opened/switched to the thread, `'close'` when it closed it. */
  kind: 'open' | 'close';
  /** Stable thread id (`thid`) the wallet used; the default thread is `'default'`. */
  thid: string;
  /** Human-facing title the wallet supplied, when any (`open` only). */
  title?: string;
  /** The wallet controller's `did:key`, when known. */
  controllerDid: string | null;
}

/**
 * A runtime adapter instance, as constructed by {@link CreateRuntimeAdapter}.
 *
 * Every hook is optional except {@link handleInbound} — an adapter that
 * only cares about inbound traffic can implement nothing else. See the
 * module-level JSDoc for the order hooks fire in and the fault-isolation
 * guarantee (a throwing hook is caught and logged, never fatal).
 */
export interface Ac2RuntimeAdapter {
  /** Stable identifier for logs and `daemon.status` (e.g. `'socket'`). */
  readonly id: string;
  /**
   * When `true`, the daemon will NOT infer runtime liveness from
   * control-socket agent registration (`agent.hello`): the adapter is
   * declaring that it owns its own runtime and will call
   * {@link Ac2RuntimeHost.reportRuntimeReady} once that runtime is alive
   * (e.g. the gateway WebSocket connected). Adapters that instead deliver
   * inbound frames to a separately-registered control-socket agent (the
   * built-in `socket` adapter) leave this unset, so the daemon treats that
   * agent's `agent.hello` as the liveness signal.
   *
   * This only affects WHEN the daemon starts awaiting a wallet (see
   * {@link Ac2RuntimeHost.reportRuntimeReady}); it never changes how inbound
   * frames are handled.
   */
  readonly managesOwnReadiness?: boolean;
  /** Called once, right after construction, before any wallet connects. */
  start?(): void | Promise<void>;
  /** Called every time the wallet channel opens (including reconnects). */
  onConnected?(info: Ac2RuntimeConnectionInfo): void | Promise<void>;
  /**
   * Called once per inbound wallet frame while the connection is open and
   * not {@link Ac2RuntimeConnectionInfo.locked | locked}. Never called for a
   * locked connection.
   */
  handleInbound(message: Ac2RuntimeInbound): void | Promise<void>;
  /**
   * Called when the wallet opens/switches or closes a conversation thread
   * (see {@link Ac2RuntimeConversationEvent}). Adapters use it to keep their
   * notion of the ACTIVE thread in step with the wallet's UI, so live
   * activity (thinking/tool/typing) and replayed history are scoped to the
   * thread the user is actually looking at.
   */
  onConversation?(event: Ac2RuntimeConversationEvent): void | Promise<void>;
  /** Called when the wallet channel drops (the daemon may reconnect afterwards). */
  onDisconnected?(reason: string): void | Promise<void>;
  /** Called once, when the daemon itself is shutting down. */
  stop?(): void | Promise<void>;
}

/**
 * The module contract a loadable adapter package must satisfy: a named
 * export called `createRuntimeAdapter` with this signature. The daemon
 * resolves a package by specifier (`import(specifier)`), reads this export,
 * and calls it with the {@link Ac2RuntimeHost} and the caller-supplied
 * config object (parsed JSON, or `{}` if none was given).
 *
 * ```ts
 * // my-adapter-package/index.ts
 * import type { CreateRuntimeAdapter } from '@algorandfoundation/ac2-sdk/runtime';
 *
 * export const createRuntimeAdapter: CreateRuntimeAdapter = (host, config) => ({
 *   id: 'my-adapter',
 *   async handleInbound(message) {
 *     host.log(`got ${message.payload}`);
 *     await host.send('ack');
 *   },
 * });
 * ```
 */
export type CreateRuntimeAdapter = (
  host: Ac2RuntimeHost,
  config: Record<string, unknown>,
) => Ac2RuntimeAdapter | Promise<Ac2RuntimeAdapter>;
