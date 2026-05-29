import { useContext } from 'react';
import { useStore } from '@tanstack/react-store';

import { WalletProviderContext } from '@/providers/ReactNativeProvider';
import { keyStore } from '@/stores/keystore';
import { accountsStore } from '@/stores/accounts';
import { passkeysStore } from '@/stores/passkeys';
import { sessionsStore } from '@/stores/sessions';
import { identitiesStore } from '@/stores/identities';

export function useProvider() {
  const provider = useContext(WalletProviderContext);
  if (provider === null) throw new Error('No Provider Found');

  // Hydrate the store in the context (React)
  const keys = useStore(keyStore, (state) => state.keys);
  const status = useStore(keyStore, (state) => state.status);
  const accounts = useStore(accountsStore, (state) => state.accounts);
  const passkeys = useStore(passkeysStore, (state) => state.passkeys);
  const sessions = useStore(sessionsStore, (state) => state.sessions);
  const identities = useStore(identitiesStore, (state) => state.identities);

  return { ...provider, keys, status, accounts, passkeys, sessions, identities };
}
