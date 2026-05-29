import { useEventListener } from 'expo';
import { Stack } from 'expo-router';
import { install } from 'react-native-quick-crypto';
import { keyStore } from '@/stores/keystore';
import { keyStoreHooks } from '@/stores/before-after';
import { accountsStore } from '@/stores/accounts';
import { identitiesStore } from '@/stores/identities';
import { ReactNativeProvider, WalletProvider } from '@/providers/ReactNativeProvider';
import { passkeysStore } from '@/stores/passkeys';
import { registerGlobals } from 'react-native-webrtc';
import { globalPolyfill, setupNavigatorPolyfill } from '@/lib/polyfill';
import ReactNativePasskeyAutofill from '@algorandfoundation/react-native-passkey-autofill';
import { bootstrap } from '@/lib/bootstrap';
import { PreventScreenshotProvider } from '@/providers/PreventScreenshotProvider';
import React from 'react';
import { ReactKeystoreOptions } from '@algorandfoundation/react-native-keystore';

globalPolyfill();
registerGlobals();
install();

const biometricOptions: ReactKeystoreOptions['keystore']['authentication'] = {
  biometrics: true,
  prompt: 'Authenticate to access your wallet',
};

const provider = new ReactNativeProvider(
  {
    id: 'react-native-wallet',
    name: 'React Native Wallet',
  },
  {
    logs: true,
    accounts: {
      store: accountsStore,
      keystore: {
        autoPopulate: true,
      },
    },
    identities: {
      store: identitiesStore,
      keystore: {
        autoPopulate: true,
      },
    },
    passkeys: {
      store: passkeysStore,
      keystore: {
        autoPopulate: true,
      },
    },
    keystore: {
      store: keyStore,
      hooks: keyStoreHooks,
      authentication: biometricOptions,
    },
  },
);

setupNavigatorPolyfill();

export default function RootLayout() {
  React.useEffect(() => {
    bootstrap(biometricOptions).catch((e) => console.error('Bootstrap promise error:', e));
  }, []);

  useEventListener(ReactNativePasskeyAutofill, 'onPasskeyAdded', (event) => {
    console.log('Passkey added via autofill:', event);
    if (event.success) {
      bootstrap(biometricOptions).catch((e) =>
        console.error('Failed to reload keys after passkey added:', e),
      );
    }
  });

  useEventListener(ReactNativePasskeyAutofill, 'onPasskeyAuthenticated', (event) => {
    console.log('Passkey authenticated via autofill:', event);
    if (event.success) {
      bootstrap(biometricOptions).catch((e) =>
        console.error('Failed to reload keys after passkey authenticated:', e),
      );
    }
  });

  return (
    <PreventScreenshotProvider>
      <WalletProvider provider={provider}>
        <Stack />
      </WalletProvider>
    </PreventScreenshotProvider>
  );
}
