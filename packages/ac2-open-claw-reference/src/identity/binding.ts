/**
 * Controller-binding policy for the AC2 agent.
 *
 * An OpenClaw agent install registers itself to the **first** controller
 * (wallet) that grants it an identity, and stays bound to that controller. A
 * *different* controller connecting afterwards — for example because the mobile
 * wallet flushed its keystore and now presents a brand-new account key — must
 * NOT be able to silently take over the agent (which would rotate the agent's
 * identity, orphan the bound controller's conversation context, and hand a
 * stranger the agent's tools). Instead the connection is *locked*: the agent
 * neither reuses the bound identity nor bootstraps a fresh one, and asks the
 * operator to clear the agent's keys under `~/.openclaw` (`ac2 forget`) before a
 * new controller can register.
 *
 * This module holds only the pure decision so it can be unit-tested in
 * isolation from the pairing/session machinery.
 */

/**
 * Outcome of evaluating a connecting controller against the bound one.
 *
 * - `register` — no controller is bound yet (first run): bootstrap an identity
 *   and bind to this controller.
 * - `reuse` — the connecting controller is the bound one (or the live link did
 *   not report an account, e.g. a presence-only reconnect): reuse the stored
 *   identity and keep the session context.
 * - `locked` — a *different* controller is connecting to an already-bound
 *   agent: refuse the takeover and require operator action.
 */
export type ControllerBindingDecision = 'register' | 'reuse' | 'locked';

export interface ControllerBindingParams {
  /**
   * Controller DID the agent is already bound to (normalized), or `undefined`
   * when the agent has never been granted an identity.
   */
  boundControllerDid?: string | undefined;
  /**
   * Controller DID of the connecting wallet (normalized), or `undefined` when
   * the live link did not report an account (e.g. a presence-only reconnect).
   */
  connectedAccountDid?: string | undefined;
  /**
   * Whether a stored identity is available to reuse for this connection
   * (either the connection's own grant or the install-wide bound identity).
   */
  hasStoredIdentity: boolean;
}

/**
 * Decide how to treat a connecting controller relative to the bound one.
 *
 * The foreign-controller check runs first and is deliberately strict: as soon
 * as the agent is bound (`boundControllerDid` set) and the live link reports a
 * *different* account, the connection is locked — even if a stored identity
 * exists — so a new wallet can never reuse or overwrite the bound identity.
 */
export function decideControllerBinding(
  params: ControllerBindingParams,
): ControllerBindingDecision {
  const { boundControllerDid, connectedAccountDid, hasStoredIdentity } = params;

  if (
    boundControllerDid !== undefined &&
    connectedAccountDid !== undefined &&
    connectedAccountDid !== boundControllerDid
  ) {
    return 'locked';
  }

  return hasStoredIdentity ? 'reuse' : 'register';
}
