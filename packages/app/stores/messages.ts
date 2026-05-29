import { Store } from '@tanstack/react-store';
import { createMMKV } from 'react-native-mmkv';

export interface Message {
  id: string;
  text: string;
  sender: 'me' | 'peer';
  timestamp: number;
  address: string;
  origin: string;
  requestId: string;
}

export interface MessagesState {
  messages: Message[];
}

const messagesLocalStorage = createMMKV({
  id: 'messages',
});

// Load initial state from storage
const loadInitialMessages = (): MessagesState => {
  try {
    const stored = messagesLocalStorage.getString('messages');
    if (stored) {
      const parsed = JSON.parse(stored);
      return { messages: parsed };
    }
  } catch (error) {
    console.error('Failed to load messages from storage:', error);
  }
  return { messages: [] };
};

export const messagesStore = new Store<MessagesState>(loadInitialMessages());

// Subscribe to store changes and save to storage
messagesStore.subscribe(() => {
  const state = messagesStore.state;
  try {
    messagesLocalStorage.set('messages', JSON.stringify(state.messages));
  } catch (error) {
    console.error('Failed to save messages to storage:', error);
  }
});

export function addMessage(message: Omit<Message, 'id' | 'timestamp'>) {
  messagesStore.setState((state) => ({
    ...state,
    messages: [
      ...state.messages,
      {
        ...message,
        id: Math.random().toString(36).substring(7),
        timestamp: Date.now(),
      },
    ],
  }));
}

export function clearMessages(address: string, origin: string, requestId: string) {
  messagesStore.setState((state) => ({
    ...state,
    messages: state.messages.filter(
      (m) => m.address !== address || m.origin !== origin || m.requestId !== requestId,
    ),
  }));
}
