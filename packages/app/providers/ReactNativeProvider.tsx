import { createContext, type ReactNode } from 'react';
import { Provider } from '@algorandfoundation/wallet-provider';

import { WithKeyStore } from '@algorandfoundation/react-native-keystore';
import {
  Account,
  AccountStoreExtension,
  WithAccountStore,
} from '@algorandfoundation/accounts-store';
import type { Identity } from '@algorandfoundation/identities-store';
import { WithIdentities, type IdentitiesExtension } from '@algorandfoundation/identities-extension';
import { Passkey, PasskeyStoreExtension, WithPasskeyStore } from '@/extensions/passkeys';
import type { KeyStoreAPI, Key } from '@algorandfoundation/keystore';
import { type LogMessage, WithLogStore, type LogStoreApi } from '@algorandfoundation/log-store';
import type { keyStoreHooks } from '@/stores/before-after';
import {
  KeystoreAccount,
  WithAccountsKeystore,
} from '@algorandfoundation/accounts-keystore-extension';
import { WithPasskeysKeystore } from '@/extensions/passkeys-keystore';

export class ReactNativeProvider extends Provider<typeof ReactNativeProvider.EXTENSIONS> {
  static EXTENSIONS = [
    WithLogStore,
    WithKeyStore,
    WithAccountStore,
    WithPasskeyStore,
    WithAccountsKeystore,
    WithPasskeysKeystore,
    WithIdentities,
  ] as const;

  keys!: Key[];
  accounts!: Account[];
  identities!: Identity[];
  passkeys!: Passkey[];
  logs!: LogMessage[];
  status!: string;

  account!: AccountStoreExtension<Account | KeystoreAccount>['account'];
  identity!: IdentitiesExtension['identity'];
  passkey!: PasskeyStoreExtension['passkey'];
  // The generic Keystore Interface
  key!: {
    store: KeyStoreAPI & { clear: () => Promise<void>; hooks: typeof keyStoreHooks };
  };
  log!: LogStoreApi;
}

export const WalletProviderContext = createContext<null | ReactNativeProvider>(null);

export interface WalletProviderProps {
  children: ReactNode;
  provider: ReactNativeProvider;
}
export function WalletProvider({ children, provider }: WalletProviderProps) {
  return (
    <WalletProviderContext.Provider value={provider}>{children}</WalletProviderContext.Provider>
  );
}
