import type { Account, AccountStoreState } from '@algorandfoundation/accounts-store';
import { Store } from '@tanstack/react-store';
import { KeystoreAccount } from '@algorandfoundation/accounts-keystore-extension';

export const accountsStore = new Store<AccountStoreState<Account | KeystoreAccount>>({
  accounts: [],
});
