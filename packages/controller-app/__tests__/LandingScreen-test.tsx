import React from 'react';
import { render } from '@testing-library/react-native';
import LandingScreen from '../app/landing';

// Mock expo-router
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  }),
}));

// Mock expo-constants
jest.mock('expo-constants', () => ({
  expoConfig: {
    extra: {
      provider: {
        name: 'Rocca',
        primaryColor: '#3B82F6',
        secondaryColor: '#E1EFFF',
        accentColor: '#10B981',
        welcomeMessage: 'Your identity, connected.',
        showAccounts: true,
        showPasskeys: true,
        showIdentities: true,
        showConnections: true,
      },
    },
  },
}));

// Mock useProvider hook
jest.mock('@/hooks/useProvider', () => ({
  useProvider: () => ({
    key: { store: { clear: jest.fn() } },
    identity: { store: { clear: jest.fn() } },
    account: { store: { clear: jest.fn() } },
    passkey: { store: { clear: jest.fn() } },
    identities: [{ did: 'did:key:z6Mkh...' }],
    accounts: [{ address: 'ADDR123...', balance: 100 }],
    passkeys: [],
    sessions: [],
  }),
}));

// Mock MaterialIcons
jest.mock('@expo/vector-icons', () => ({
  MaterialIcons: 'MaterialIcons',
}));

describe('<LandingScreen />', () => {
  it('renders correctly with mocked provider data', () => {
    const { getByText } = render(<LandingScreen />);

    // Check for welcome message
    expect(getByText('Your identity, connected.')).toBeTruthy();

    // Check for balance (mocked as 100)
    expect(getByText('$100')).toBeTruthy();

    // Check for identity DID (partial check because it might be truncated in UI)
    // In landing.tsx: {activeIdentity?.did || 'No identity found'}
    expect(getByText('did:key:z6Mkh...')).toBeTruthy();
  });

  it('renders provider services when enabled', () => {
    const { getByText, getAllByText } = render(<LandingScreen />);

    expect(getByText('Accounts')).toBeTruthy();
    expect(getByText('Passkeys')).toBeTruthy();
    expect(getByText('Identities')).toBeTruthy();
    expect(getByText('Connections')).toBeTruthy();
    expect(getAllByText('0 Total').length).toBeGreaterThanOrEqual(1);
  });
});
