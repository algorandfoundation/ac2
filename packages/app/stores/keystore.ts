import { Store } from '@tanstack/react-store';
import { KeyStoreState } from '@algorandfoundation/keystore';

export const keyStore = new Store<KeyStoreState>({
  keys: [],
  status: 'loading',
});
