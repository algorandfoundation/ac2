import { Store } from '@tanstack/react-store';
import { LogStoreState } from '@algorandfoundation/log-store';

export const logsStore = new Store<LogStoreState>({
  logs: [],
});
