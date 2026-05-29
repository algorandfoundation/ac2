import type { KeyStoreExtension, KeyStoreOptions } from '@algorandfoundation/keystore';
import type { PasskeyStoreExtension, PasskeyStoreOptions } from '@/extensions/passkeys';
import type { ExtensionOptions } from '@algorandfoundation/wallet-provider';

/**
 * Options for the PasskeysKeystore extension.
 */
export interface PasskeysKeystoreExtensionOptions
  extends ExtensionOptions, PasskeyStoreOptions, KeyStoreOptions {
  passkeys: PasskeyStoreOptions['passkeys'] & {
    keystore: {
      /**
       * Whether to automatically add passkeys for all compatible keys in the keystore.
       * Defaults to true.
       */
      autoPopulate?: boolean;
    };
  };
}

/**
 * The interface exposed by the Passkeys Keystore Extension.
 *
 * This extension bridges the Passkey Store and the Keystore,
 * providing passkeys that are backed by the keystore.
 */
export interface PasskeysKeystoreExtension extends PasskeyStoreExtension, KeyStoreExtension {
  passkey: PasskeyStoreExtension['passkey'] & {
    keystore: {
      autoPopulate: boolean;
    };
  };
}
