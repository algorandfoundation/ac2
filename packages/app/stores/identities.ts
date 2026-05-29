import { Store } from '@tanstack/react-store';
import type { IdentityStoreState } from '@algorandfoundation/identities-store';

export const identitiesStore = new Store<IdentityStoreState>({
  identities: [],
});
