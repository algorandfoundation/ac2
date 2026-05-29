import type { Extension } from '@algorandfoundation/wallet-provider';
import { Store } from '@tanstack/store';
import Hook from 'before-after-hook';
import { addPasskey, clearPasskeys, getPasskey, getPasskeys, removePasskey } from './store';
import type { Passkey, PasskeyStoreExtension, PasskeyStoreState } from './types';
import type { LogStoreExtension } from '@algorandfoundation/log-store';

/**
 * An extension that provides a passkey store for managing passkeys.
 *
 * @param provider - The wallet provider.
 * @param options - The extension options.
 * @returns The passkey store extension.
 *
 * @example
 * ```typescript
 * const provider = new MyProvider(..., {
 *   passkeys: {
 *     store: new Store({ passkeys: [] }),
 *     hooks: new HookCollection()
 *   }
 * });
 * ```
 */
export const WithPasskeyStore: Extension<PasskeyStoreExtension> = (
  _provider: Partial<LogStoreExtension>,
  options,
) => {
  const log = _provider.log;
  const passkeyStore = options?.passkeys?.store ?? new Store<PasskeyStoreState>({ passkeys: [] });
  const passkeyHooks = options?.passkeys?.hooks ?? new Hook.Collection<any>();

  const passkeyStoreApi = {
    addPasskey: async (passkey: Passkey) => {
      log?.info(`addPasskey called: id=${passkey.id}, name=${passkey.name}`, {}, 'PasskeyStore');
      return passkeyHooks('add', addPasskey, {
        store: passkeyStore,
        passkey,
      });
    },
    removePasskey: async (id: string) => {
      log?.info(`removePasskey called: id=${id}`, {}, 'PasskeyStore');
      return passkeyHooks('remove', removePasskey, {
        store: passkeyStore,
        id,
      });
    },
    getPasskey: async (id: string) => {
      log?.debug(`getPasskey called: id=${id}`, {}, 'PasskeyStore');
      return passkeyHooks('get', getPasskey, {
        store: passkeyStore,
        id,
      });
    },
    getPasskeys: async () => {
      log?.debug('getPasskeys called', {}, 'PasskeyStore');
      return passkeyHooks('list', getPasskeys, {
        store: passkeyStore,
      });
    },
    clear: async () => {
      log?.info('clear called', {}, 'PasskeyStore');
      return passkeyHooks('clear', clearPasskeys, {
        store: passkeyStore,
      });
    },
    hooks: passkeyHooks,
  };

  return {
    get passkeys() {
      return passkeyStore.state.passkeys;
    },
    passkey: {
      store: passkeyStoreApi,
    },
  } as PasskeyStoreExtension;
};
