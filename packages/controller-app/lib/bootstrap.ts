import { Alert, Platform } from 'react-native';
import {
  AuthenticationOptions,
  fetchSecret,
  getMasterKey,
  storage,
} from '@algorandfoundation/react-native-keystore';
import {
  initializeKeyStore,
  Key,
  KeyData,
  KeyStoreState,
  setStatus,
} from '@algorandfoundation/keystore';
import { Store } from '@tanstack/store';
import ReactNativePasskeyAutofill from '@algorandfoundation/react-native-passkey-autofill';
import { keyStore } from '@/stores/keystore';
import { CredentialProviderService } from '@/lib/credentialProvider';
import { addLog } from '@algorandfoundation/log-store';

import * as Keychain from 'react-native-keychain';
import { randomBytes } from 'react-native-quick-crypto';
import { generateId } from '@algorandfoundation/wallet-provider';
import { logsStore } from '@/stores/logs';

/**
 * Bootstraps the app's keystore and native passkey autofill service.
 * This should be called on app start, and after any operation that changes the wallet's keys (e.g., import, create).
 *
 * @param options
 * @param showAlert - Whether to show an alert if the autofill service is not enabled.
 */
export async function bootstrap(options?: AuthenticationOptions, showAlert = true) {
  const logMsg = (message: string, level = 'info') => {
    addLog({
      store: logsStore,
      log: { id: generateId(), level, context: 'Bootstrap', timestamp: new Date(), message },
    });
    if (level === 'error') {
      console.error(`[Bootstrap ERROR] ${message}`);
    } else {
      console.log(`[Bootstrap INFO] ${message}`);
    }
  };

  try {
    setStatus({ store: keyStore as unknown as Store<KeyStoreState>, status: 'loading' });

    const keyIds = storage.getAllKeys();
    logMsg(`Found ${keyIds.length} keys in storage`);

    if (keyIds.length === 0) {
      logMsg('No keys found in MMKV, but ensuring master key is ready');
    }

    logMsg('Fetching master key...');
    const masterKey = await getMasterKey(options);
    logMsg('Master key retrieved');

    logMsg('Setting master key in native side...');
    await ReactNativePasskeyAutofill.setMasterKey(masterKey.toString('hex')).catch((e) => {
      logMsg(`ReactNativePasskeyAutofill.setMasterKey error: ${e}`, 'error');
    });

    if (keyIds.length === 0) {
      initializeKeyStore({
        store: keyStore as unknown as Store<KeyStoreState>,
        keys: [],
      });

      // Even if no keys, we should still configure intent actions
      await ReactNativePasskeyAutofill.configureIntentActions(
        'co.algorand.passkeyautofill.GET_PASSKEY',
        'co.algorand.passkeyautofill.CREATE_PASSKEY',
      ).catch((e) => {
        logMsg(`ReactNativePasskeyAutofill.configureIntentActions error: ${e}`, 'error');
      });

      logMsg('No keys found, setting keystore status to idle');
      setStatus({ store: keyStore as unknown as Store<KeyStoreState>, status: 'idle' });

      return;
    }

    const secrets = await Promise.all(
      keyIds.map(async (keyId) => {
        try {
          // Pass a copy because fetchSecret clears the buffer in its finally block
          return await fetchSecret<KeyData>({
            keyId,
            options: { ...options, masterKey: Buffer.from(masterKey) },
          });
        } catch (e) {
          logMsg(`fetchSecret failed for key ${keyId}: ${e}`, 'error');
          return null;
        }
      }),
    );

    const keys = secrets
      .filter((k) => k !== null)
      .map(({ privateKey, seed, ...rest }: any) => rest) as Key[];

    logMsg(`Found ${keys.length} keys in storage`);
    keys.forEach((k) => {
      const pkType =
        k.publicKey instanceof Uint8Array
          ? 'Uint8Array'
          : Buffer.isBuffer(k.publicKey)
            ? 'Buffer'
            : Array.isArray(k.publicKey)
              ? 'Array'
              : typeof k.publicKey;
      const hasPK = pkType !== 'undefined' && k.publicKey !== null;
      logMsg(
        `  key: id=${k.id}, type=${k.type}, algorithm=${k.algorithm}, hasPublicKey=${hasPK} (${pkType})`,
      );
      if (k.metadata) {
        logMsg(`    metadata: ${JSON.stringify(k.metadata)}`);
      }
    });

    // Log P256 key details for recovery diagnostics
    const p256Secrets = secrets.filter(
      (s) => s !== null && (s.type === 'hd-derived-p256' || s.type === 'xhd-derived-p256'),
    );
    p256Secrets.forEach((s) => {
      const pkType = s!.privateKey instanceof Uint8Array ? 'Uint8Array' : typeof s!.privateKey;
      logMsg(`  P256 key ${s!.id}: privateKey type=${pkType}, hasPublicKey=${!!s!.publicKey}`);
    });

    initializeKeyStore({
      store: keyStore as unknown as Store<KeyStoreState>,
      keys,
    });

    const hdRootKey =
      keys.find((k) => k.type === 'hd-root-key') ||
      keys.find((k) => k.type === 'xhd-root-key') ||
      keys.find((k) => k.type === 'hd-seed');

    if (hdRootKey) {
      logMsg(`Setting HD root key ID in native side: ${hdRootKey.id}`);
      await ReactNativePasskeyAutofill.setHdRootKeyId(hdRootKey.id).catch((e) => {
        logMsg(`ReactNativePasskeyAutofill.setHdRootKeyId error: ${e}`, 'error');
      });
    }

    const isEnabled = await CredentialProviderService.isEnabledCredentialProviderService().catch(
      (e) => {
        logMsg(`CredentialProviderService.isEnabledCredentialProviderService error: ${e}`, 'error');
        return false;
      },
    );
    logMsg(`CredentialProviderService isEnabled: ${isEnabled}`);

    if (!isEnabled && Platform.OS === 'android') {
      logMsg('CredentialProviderService is NOT enabled. Showing alert.');
      if (showAlert) {
        Alert.alert(
          'Enable Autofill Service',
          'To use passkeys, you need to enable the autofill service for this app in your Android settings.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Open Settings',
              onPress: async () => {
                await CredentialProviderService.showCredentialProviderSettings();
              },
            },
          ],
        );
      }
    }

    await ReactNativePasskeyAutofill.configureIntentActions(
      'co.algorand.passkeyautofill.GET_PASSKEY',
      'co.algorand.passkeyautofill.CREATE_PASSKEY',
    ).catch((e) => {
      logMsg(`ReactNativePasskeyAutofill.configureIntentActions error: ${e}`, 'error');
    });

    if (keys.length > 0) {
      logMsg('Setting keystore status to ready');
      setStatus({ store: keyStore as unknown as Store<KeyStoreState>, status: 'ready' });
    } else {
      logMsg('No keys found, setting keystore status to idle');
      setStatus({ store: keyStore as unknown as Store<KeyStoreState>, status: 'idle' });
    }
  } catch (e) {
    logMsg(`Bootstrap failed: ${e}`, 'error');
    setStatus({ store: keyStore as unknown as Store<KeyStoreState>, status: 'error' });
  }
}
