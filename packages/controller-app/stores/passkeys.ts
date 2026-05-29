import { Store } from '@tanstack/react-store';
import type { PasskeyStoreState } from '@/extensions/passkeys/types';

export const passkeysStore = new Store<PasskeyStoreState>({
  passkeys: [],
});
