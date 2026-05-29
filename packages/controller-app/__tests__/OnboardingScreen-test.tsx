import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as bip39 from '@scure/bip39';
import OnboardingScreen from '../app/onboarding';

// Stable router spies across renders
const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockBack = jest.fn();

// Mock expo-router
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: mockBack,
  }),
  usePathname: () => '/onboarding',
}));

// Mock expo-constants
jest.mock('expo-constants', () => ({
  expoConfig: {
    extra: {
      provider: {
        name: 'Rocca',
        primaryColor: '#3B82F6',
        secondaryColor: '#E1EFFF',
      },
    },
  },
}));

// Stable key/account/identity/passkey store spies (names must start with
// `mock` so they can be referenced from `jest.mock` factories, which are
// hoisted above regular variable declarations).
const mockKeyStore = {
  clear: jest.fn().mockResolvedValue(undefined),
  import: jest.fn().mockResolvedValue('seed-id'),
  generate: jest.fn().mockImplementation(async ({ type }: { type: string }) => `${type}-id`),
};
const mockAccountStore = { clear: jest.fn().mockResolvedValue(undefined) };
const mockIdentityStore = { clear: jest.fn().mockResolvedValue(undefined) };
const mockPasskeyStore = { clear: jest.fn().mockResolvedValue(undefined) };

// Mock useProvider hook
jest.mock('@/hooks/useProvider', () => ({
  useProvider: () => ({
    keys: [],
    key: { store: mockKeyStore },
    account: { store: mockAccountStore },
    identity: { store: mockIdentityStore },
    passkey: { store: mockPasskeyStore },
    identities: [],
    accounts: [],
    provider: {
      keystore: {
        generateKey: jest.fn().mockResolvedValue({ id: 'key1' }),
      },
    },
  }),
}));

// Mock bip39 - generate a full 24-word phrase since indices 3, 7, 15, 21 are
// required for verification.
const MOCK_PHRASE =
  'apple banana cherry date elderberry fig grape honeydew iceberg jackfruit kiwi lemon ' +
  'mango nectarine orange papaya quince raspberry strawberry tangerine ugli vanilla watermelon xigua';
jest.mock('@scure/bip39', () => ({
  generateMnemonic: jest.fn().mockReturnValue(MOCK_PHRASE),
  mnemonicToSeed: jest.fn().mockResolvedValue(new Uint8Array(64)),
  wordlist: { english: [] },
}));

// Mock react-native-passkey-autofill
jest.mock('@algorandfoundation/react-native-passkey-autofill', () => ({
  setHdRootKeyId: jest.fn().mockResolvedValue(undefined),
  setMasterKey: jest.fn().mockResolvedValue(undefined),
}));

// Mock Reanimated
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return Reanimated;
});

// Mock bootstrap
jest.mock('@/lib/bootstrap', () => ({
  bootstrap: jest.fn().mockResolvedValue(undefined),
}));

// Mock MaterialIcons
jest.mock('@expo/vector-icons', () => ({
  MaterialIcons: 'MaterialIcons',
}));

const PHRASE_WORDS = MOCK_PHRASE.split(' ');
const VERIFY_INDICES = [3, 7, 15, 21];

async function advanceToVerifyStep(utils: ReturnType<typeof render>) {
  const { getByText, findByText } = utils;
  fireEvent.press(getByText('Create Wallet'));
  fireEvent.press(await findByText('View Secret'));
  fireEvent.press(await findByText('Verify Recovery Phrase'));
  // Wait for verify inputs to appear
  await findByText(
    'Enter the requested words from your phrase to confirm you have a correct backup.',
  );
}

describe('<OnboardingScreen />', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // `clearAllMocks` also wipes mockReturnValue set at module scope; restore.
    (bip39.generateMnemonic as jest.Mock).mockReturnValue(MOCK_PHRASE);
    (bip39.mnemonicToSeed as jest.Mock).mockResolvedValue(new Uint8Array(64));
    mockKeyStore.clear.mockResolvedValue(undefined);
    mockKeyStore.import.mockResolvedValue('seed-id');
    mockKeyStore.generate.mockImplementation(async ({ type }: { type: string }) => `${type}-id`);
    mockAccountStore.clear.mockResolvedValue(undefined);
    mockIdentityStore.clear.mockResolvedValue(undefined);
    mockPasskeyStore.clear.mockResolvedValue(undefined);
  });

  it('renders welcome step initially', () => {
    const { getByText } = render(<OnboardingScreen />);

    expect(getByText('Welcome to Rocca')).toBeTruthy();
    expect(getByText('Create Wallet')).toBeTruthy();
  });

  it('transitions to generate step when clicking Create Wallet', async () => {
    const { getByText, findByText } = render(<OnboardingScreen />);

    fireEvent.press(getByText('Create Wallet'));

    expect(await findByText('Secure Your Identity.')).toBeTruthy();
    expect(await findByText('View Secret')).toBeTruthy();
  });

  it('shows the recovery phrase after generation', async () => {
    const { getByText, findByText } = render(<OnboardingScreen />);

    fireEvent.press(getByText('Create Wallet'));

    // Wait for the transition and then press "View Secret"
    const revealButton = await findByText('View Secret');
    fireEvent.press(revealButton);

    // Now it should show "Verify Recovery Phrase"
    expect(await findByText('Verify Recovery Phrase')).toBeTruthy();
  });

  it('shows a Verification Failed alert when entered words are incorrect', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const utils = render(<OnboardingScreen />);
    await advanceToVerifyStep(utils);

    const { getAllByPlaceholderText, getByText } = utils;

    // Fill all verification inputs with wrong values
    for (const idx of VERIFY_INDICES) {
      const input = getAllByPlaceholderText(`Word #${idx + 1}`)[0];
      fireEvent.changeText(input, 'wrong');
    }

    await act(async () => {
      fireEvent.press(getByText('Check Words'));
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Verification Failed',
      expect.stringContaining("don't match your recovery phrase"),
      expect.any(Array),
    );
    // Verification did not succeed -> no keystore writes, no navigation
    expect(mockKeyStore.import).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('completes the onboarding flow and renders the app after correct verification', async () => {
    const utils = render(<OnboardingScreen />);
    await advanceToVerifyStep(utils);

    const { getAllByPlaceholderText, getByText, findByText } = utils;

    // Enter the correct words for every requested index. Mix casing /
    // whitespace to confirm the verification is tolerant to it (this is the
    // exact bug path where verification previously did not work).
    VERIFY_INDICES.forEach((idx, i) => {
      const input = getAllByPlaceholderText(`Word #${idx + 1}`)[0];
      const raw = PHRASE_WORDS[idx];
      const value = i % 2 === 0 ? `  ${raw.toUpperCase()} ` : raw;
      fireEvent.changeText(input, value);
    });

    await act(async () => {
      fireEvent.press(getByText('Check Words'));
    });

    // The success UI is rendered before the async navigation completes
    expect(await findByText('Identity Secured!')).toBeTruthy();

    // All stores must be cleared prior to importing the new seed
    await waitFor(() => {
      expect(mockKeyStore.clear).toHaveBeenCalledTimes(1);
      expect(mockAccountStore.clear).toHaveBeenCalledTimes(1);
      expect(mockIdentityStore.clear).toHaveBeenCalledTimes(1);
      expect(mockPasskeyStore.clear).toHaveBeenCalledTimes(1);
    });

    // Seed import + HD key derivation chain runs
    await waitFor(() => {
      expect(mockKeyStore.import).toHaveBeenCalledTimes(1);
      // hd-root-key -> ed25519 account -> ed25519 identity
      expect(mockKeyStore.generate).toHaveBeenCalledTimes(3);
    });

    // Finally the app navigates to /landing, which is what renders the app
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/landing');
    });
  });
});
