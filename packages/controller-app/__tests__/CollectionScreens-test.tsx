import React from 'react';
import { render } from '@testing-library/react-native';
import AccountsScreen from '../app/accounts';
import PasskeysScreen from '../app/passkeys';
import IdentitiesScreen from '../app/identities';
import ConnectionsScreen from '../app/connections';

// Mock expo-router
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    back: jest.fn(),
  }),
  Stack: {
    Screen: () => null,
  },
}));

// Mock useProvider hook
jest.mock('@/hooks/useProvider', () => ({
  useProvider: () => ({
    identities: [{ did: 'did:key:123' }],
    accounts: [{ address: 'ADDR123', balance: BigInt(100) }],
    passkeys: [{ id: 'cred123', name: 'Test Passkey', createdAt: new Date().getTime() }],
    sessions: [{ id: 'sess123', origin: 'example.com' }],
    passkey: {
      store: {
        removePasskey: jest.fn(),
      },
    },
  }),
}));

// Mock MaterialIcons
jest.mock('@expo/vector-icons', () => ({
  MaterialIcons: 'MaterialIcons',
}));

describe('Collection Screens', () => {
  it('renders AccountsScreen correctly', () => {
    const { getByText, getAllByText } = render(<AccountsScreen />);
    expect(getByText('ADDR123')).toBeTruthy();
    expect(getAllByText('$100').length).toBeGreaterThanOrEqual(1);
  });

  it('renders PasskeysScreen correctly', () => {
    const { getByText } = render(<PasskeysScreen />);
    expect(getByText('Test Passkey')).toBeTruthy();
    expect(getByText('ID: cred123')).toBeTruthy();
  });

  it('renders IdentitiesScreen correctly', () => {
    const { getByText } = render(<IdentitiesScreen />);
    expect(getByText('did:key:123')).toBeTruthy();
  });

  it('renders ConnectionsScreen correctly', () => {
    const { getByText } = render(<ConnectionsScreen />);
    expect(getByText('example.com')).toBeTruthy();
  });
});
