import type { Store } from '@tanstack/store';
import type { Passkey, PasskeyStoreState } from './types';

/**
 * Adds a passkey to the store.
 *
 * @param params - The add parameters.
 * @param params.store - The TanStack store instance for {@link PasskeyStoreState}.
 * @param params.passkey - The {@link Passkey} to add.
 * @returns The added {@link Passkey}.
 *
 * @example
 * ```typescript
 * addPasskey({ store, passkey: { id: "1", name: "My Passkey", ... } });
 * ```
 */
export function addPasskey({
  store,
  passkey,
}: {
  store: Store<PasskeyStoreState>;
  passkey: Passkey;
}): Passkey {
  store.setState((state) => {
    const filtered = state.passkeys.filter((p) => p.id !== passkey.id);
    return {
      ...state,
      passkeys: [passkey, ...filtered],
    };
  });
  return passkey;
}

/**
 * Removes a passkey from the store by its ID.
 *
 * @param params - The removal parameters.
 * @param params.store - The TanStack store instance for {@link PasskeyStoreState}.
 * @param params.id - The ID of the passkey to remove.
 *
 * @example
 * ```typescript
 * removePasskey({ store, id: "1" });
 * ```
 */
export function removePasskey({
  store,
  id,
}: {
  store: Store<PasskeyStoreState>;
  id: string;
}): void {
  store.setState((state) => {
    return {
      ...state,
      passkeys: state.passkeys.filter((passkey) => passkey.id !== id),
    };
  });
}

/**
 * Retrieves a passkey from the store by its ID.
 *
 * @param params - The retrieval parameters.
 * @param params.store - The TanStack store instance for {@link PasskeyStoreState}.
 * @param params.id - The ID of the passkey to retrieve.
 * @returns The {@link Passkey} if found, otherwise undefined.
 *
 * @example
 * ```typescript
 * getPasskey({ store, id: "1" });
 * ```
 */
export function getPasskey({
  store,
  id,
}: {
  store: Store<PasskeyStoreState>;
  id: string;
}): Passkey | undefined {
  return store.state.passkeys.find((passkey) => passkey.id === id);
}

/**
 * Retrieves all passkeys from the store.
 *
 * @param params - The retrieval parameters.
 * @param params.store - The TanStack store instance for {@link PasskeyStoreState}.
 * @returns An array of all {@link Passkey}s.
 *
 * @example
 * ```typescript
 * getPasskeys({ store });
 * ```
 */
export function getPasskeys({ store }: { store: Store<PasskeyStoreState> }): Passkey[] {
  return store.state.passkeys;
}

/**
 * Clears all passkeys from the store.
 *
 * @param params - The store parameters.
 * @param params.store - The TanStack store instance for {@link PasskeyStoreState}.
 *
 * @example
 * ```typescript
 * clearPasskeys({ store });
 * ```
 */
export function clearPasskeys({ store }: { store: Store<PasskeyStoreState> }): void {
  store.setState((state) => {
    return {
      ...state,
      passkeys: [],
    };
  });
}
