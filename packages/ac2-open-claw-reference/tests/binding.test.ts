import { describe, it, expect } from 'vitest';

import { decideControllerBinding } from '../src/identity/binding.js';

/**
 * An agent install registers to the first controller (wallet) that grants it an
 * identity and stays bound to it. `decideControllerBinding` enforces that a
 * *different* controller cannot silently take the agent over: it must be locked
 * out until the operator clears the agent's keys under `~/.openclaw`.
 */
describe('decideControllerBinding — first-controller lock', () => {
  const BOUND = 'did:key:zBoundController';
  const OTHER = 'did:key:zOtherController';

  it('registers when no controller is bound yet (first run)', () => {
    expect(
      decideControllerBinding({
        boundControllerDid: undefined,
        connectedAccountDid: BOUND,
        hasStoredIdentity: false,
      }),
    ).toBe('register');
  });

  it('reuses the identity when the bound controller reconnects', () => {
    expect(
      decideControllerBinding({
        boundControllerDid: BOUND,
        connectedAccountDid: BOUND,
        hasStoredIdentity: true,
      }),
    ).toBe('reuse');
  });

  it('reuses on a presence-only reconnect that omits the account', () => {
    expect(
      decideControllerBinding({
        boundControllerDid: BOUND,
        connectedAccountDid: undefined,
        hasStoredIdentity: true,
      }),
    ).toBe('reuse');
  });

  it('locks out a different controller connecting to a bound agent', () => {
    expect(
      decideControllerBinding({
        boundControllerDid: BOUND,
        connectedAccountDid: OTHER,
        hasStoredIdentity: true,
      }),
    ).toBe('locked');
  });

  it('locks even if the foreign controller would otherwise have no stored identity', () => {
    // The foreign check runs before the reuse/register fallback, so a new
    // wallet can never bootstrap a fresh identity on a bound agent.
    expect(
      decideControllerBinding({
        boundControllerDid: BOUND,
        connectedAccountDid: OTHER,
        hasStoredIdentity: false,
      }),
    ).toBe('locked');
  });
});
