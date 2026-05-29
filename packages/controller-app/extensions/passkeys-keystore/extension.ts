import type {
  Key,
  KeyStoreExtension,
  KeyStoreState,
  XHDDomainP256KeyData,
} from '@algorandfoundation/keystore';
import type { Passkey, PasskeyStoreExtension } from '@/extensions/passkeys';
import type { Extension } from '@algorandfoundation/wallet-provider';
import type { Store } from '@tanstack/store';
import { toUrlSafe } from '@/utils/base64';
import type { PasskeysKeystoreExtension, PasskeysKeystoreExtensionOptions } from './types';
import type { LogStoreExtension } from '@algorandfoundation/log-store';

/**
 * Extension that bridges the passkey store and keystore.
 *
 * It automatically populates the passkey store with passkeys from the keystore.
 */
export const WithPasskeysKeystore: Extension<PasskeysKeystoreExtension> = (
  provider: KeyStoreExtension & PasskeyStoreExtension & Partial<LogStoreExtension>,
  options: PasskeysKeystoreExtensionOptions,
) => {
  const log = provider.log;
  // Ensure dependencies are present
  if (!provider.passkey) {
    throw new Error(
      'PasskeysKeystore extension requires WithPasskeyStore extension to be present on the provider.',
    );
  }
  if (!provider.key) {
    throw new Error(
      'PasskeysKeystore extension requires WithKeyStore extension to be present on the provider.',
    );
  }

  const keyStore: Store<KeyStoreState> = options.keystore.store;
  const { autoPopulate = true } = options.passkeys.keystore ?? {};

  // Hook into passkey removal to also remove from keystore
  provider.passkey.store.hooks.before('remove', async ({ id }) => {
    log?.info(`before remove hook: looking up key for passkey id=${id}`, {}, 'PasskeysKeystore');
    const foundKey = (keyStore.state.keys as Key[]).find((k) => toUrlSafe(k.id) === id);
    if (foundKey) {
      try {
        log?.info(`removing key ${foundKey.id} from keystore`, {}, 'PasskeysKeystore');
        await provider.key.store.remove(foundKey.id);
      } catch (error) {
        log?.error(
          `Failed to remove key ${foundKey.id} from keystore: ${error}`,
          {},
          'PasskeysKeystore',
        );
      }
    } else {
      log?.warn(`no matching keystore key found for passkey id=${id}`, {}, 'PasskeysKeystore');
    }
  });

  const keys: Key[] = [];

  /**
   * Creates a passkey object from a keystore key.
   */
  const createPasskeyFromKey = (key: XHDDomainP256KeyData): Passkey => {
    if (!key.publicKey) {
      throw new Error(`Key ${key.id} is missing public key`);
    }
    log?.debug(`Creating passkey from keystore key with ID: ${key.id}`, {}, 'PasskeysKeystore');

    const username = key.metadata.userHandle || 'Unnamed User';
    const origin = key.metadata.origin || 'Unnamed Origin';
    const name = `${username}@${origin}`;

    return {
      id: toUrlSafe(key.id),
      name,
      userHandle: key.metadata.userHandle,
      origin: key.metadata.origin,
      publicKey: key.publicKey,
      algorithm: key.algorithm || 'P256',
      createdAt: (key.metadata as any).createdAt || Date.now(),
      metadata: {
        ...key.metadata,
        keyId: key.id,
        type: (key as any).type,
        registered: (key.metadata as any).registered ?? false,
      },
    };
  };

  // Initial population if enabled
  if (autoPopulate) {
    let isProcessing = false;
    let nextKeys: Key[] | null = null;

    const processUpdates = async (newKeys: Key[]) => {
      console.log(
        `[PasskeysKeystore] processUpdates called with ${newKeys.length} keys. Current status: ${keyStore.state.status}`,
      );
      if (isProcessing) {
        console.log('[PasskeysKeystore] already processing, queueing next update');
        nextKeys = newKeys;
        return;
      }
      isProcessing = true;
      try {
        nextKeys = null;

        // Find added keys
        const addedKeys = newKeys.filter(
          (newKey) => !keys.some((existingKey) => existingKey.id === newKey.id),
        );

        // Find removed keys
        const removedKeys = keys.filter(
          (existingKey) => !newKeys.some((newKey) => newKey.id === existingKey.id),
        );

        // Find updated keys
        const updatedKeys = newKeys.filter((nk) => {
          const existing = keys.find((k) => k.id === nk.id);
          return existing && JSON.stringify(existing.metadata) !== JSON.stringify(nk.metadata);
        });

        console.log(
          `[PasskeysKeystore] processUpdates: ${newKeys.length} total, ${addedKeys.length} added, ${removedKeys.length} removed, ${updatedKeys.length} updated`,
        );

        if (addedKeys.length === 0 && removedKeys.length === 0 && updatedKeys.length === 0) {
          console.log('[PasskeysKeystore] No changes to process');
          return;
        }

        // Update the local cache of keys BEFORE processing to ensure consistency
        keys.length = 0;
        newKeys.forEach((k) => keys.push(k));

        // Remove passkeys for removed keys
        for (const k of removedKeys) {
          if (k.type === 'xhd-derived-p256' || k.type === 'hd-derived-p256') {
            log?.info(
              `removing passkey for removed key: ${k.id} -> ${toUrlSafe(k.id)}`,
              {},
              'PasskeysKeystore',
            );
            await provider.passkey.store.removePasskey(toUrlSafe(k.id));
          }
        }

        // Add passkeys for added keys
        for (const k of addedKeys) {
          if (k.type === 'xhd-derived-p256' || k.type === 'hd-derived-p256') {
            log?.info(
              `adding passkey for new key: ${k.id} (type=${k.type})`,
              {},
              'PasskeysKeystore',
            );
            await provider.passkey.store.addPasskey(
              createPasskeyFromKey(k as XHDDomainP256KeyData),
            );
          } else {
            log?.debug(
              `skipping non-passkey key: ${k.id} (type=${k.type})`,
              {},
              'PasskeysKeystore',
            );
          }
        }

        // Refresh passkeys for updated keys
        for (const k of updatedKeys) {
          if (k.type === 'xhd-derived-p256' || k.type === 'hd-derived-p256') {
            log?.info(`refreshing passkey for updated key: ${k.id}`, {}, 'PasskeysKeystore');
            await provider.passkey.store.addPasskey(
              createPasskeyFromKey(k as XHDDomainP256KeyData),
            );
          }
        }
      } finally {
        isProcessing = false;
        if (nextKeys) {
          const k = nextKeys;
          nextKeys = null;
          await processUpdates(k);
        }
      }
    };

    processUpdates(keyStore.state.keys as unknown as Key[]);

    keyStore.subscribe((state) => {
      console.log(
        `[PasskeysKeystore] Keystore subscriber fired. Status: ${state.status}, Keys: ${state.keys.length}`,
      );
      if (state.status !== 'ready' && state.status !== 'idle') {
        console.log(`[PasskeysKeystore] Ignoring status: ${state.status}`);
        return;
      }
      processUpdates(state.keys as unknown as Key[]);
    });
  }

  return provider as unknown as PasskeysKeystoreExtension;
};
