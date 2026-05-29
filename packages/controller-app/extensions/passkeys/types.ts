import type { ExtensionOptions } from '@algorandfoundation/wallet-provider';
import type { Store } from '@tanstack/store';
import type { HookCollection } from 'before-after-hook';

/**
 * Options for the PasskeyStore extension.
 */
export interface PasskeyStoreOptions extends ExtensionOptions {
  passkeys: {
    store: Store<PasskeyStoreState>;
    hooks: HookCollection<any>;
  };
}

/**
 * Represents a passkey.
 */
export interface Passkey {
  /**
   * The unique ID of the passkey (credential ID).
   */
  id: string;

  /**
   * The user-friendly name of the passkey.
   */
  name: string;

  /**
   * The public key associated with the passkey.
   */
  publicKey: Uint8Array;

  /**
   * The algorithm used by the passkey.
   */
  algorithm: string;

  /**
   * The user handle associated with the passkey.
   */
  userHandle?: string;

  /**
   * The origin associated with the passkey.
   */
  origin?: string;

  /**
   * The timestamp when the passkey was created.
   */
  createdAt?: number;

  /**
   * The metadata associated with the passkey.
   */
  metadata?: Record<string, any>;
}

/**
 * The state of the passkey store.
 */
export interface PasskeyStoreState {
  /**
   * The list of passkeys in the store.
   */
  passkeys: Passkey[];
}

/**
 * Represents a passkey store interface for managing passkeys.
 */
export interface PasskeyStoreExtension extends PasskeyStoreState {
  /**
   * An object that represents additional functionality provided by this extension.
   */
  passkey: {
    store: PasskeyStoreApi;
  };
}

/**
 * Interface representing a PasskeyStore extension API.
 */
export interface PasskeyStoreApi {
  /**
   * Adds a passkey to the store.
   *
   * @param passkey - The passkey to add.
   * @returns The added passkey.
   */
  addPasskey: (passkey: Passkey) => Promise<Passkey>;
  /**
   * Removes a passkey from the store by its ID.
   *
   * @param id - The ID of the passkey to remove.
   * @returns A promise that resolves when the passkey is removed.
   */
  removePasskey: (id: string) => Promise<void>;
  /**
   * Retrieves a passkey from the store by its ID.
   *
   * @param id - The ID of the passkey to retrieve.
   * @returns The passkey if found, otherwise undefined.
   */
  getPasskey: (id: string) => Promise<Passkey | undefined>;
  /**
   * Retrieves all passkeys from the store.
   *
   * @returns A promise that resolves to an array of all passkeys.
   */
  getPasskeys: () => Promise<Passkey[]>;
  /**
   * Clears all passkeys from the store.
   *
   * @returns A promise that resolves when the store is cleared.
   */
  clear: () => Promise<void>;
  /**
   * The hooks for passkey store operations.
   */
  hooks: HookCollection<any>;
}
