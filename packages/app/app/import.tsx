import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { MaterialIcons } from '@expo/vector-icons';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { validateMnemonic, mnemonicToSeed } from '@scure/bip39';
import { useProvider } from '@/hooks/useProvider';
import { identitiesStore } from '@/stores/identities';
import { accountsStore } from '@/stores/accounts';
import { passkeysStore } from '@/stores/passkeys';
import { PreventScreenshot } from '@/components/PreventScreenshot';
import { bootstrap } from '@/lib/bootstrap';
import { importDidDocument } from '@/utils/did-backup';

// Extract provider configuration from expo-constants
const config = Constants.expoConfig?.extra?.provider || {
  name: 'Rocca',
  primaryColor: '#3B82F6',
  secondaryColor: '#E1EFFF',
};

export default function ImportWalletScreen() {
  const router = useRouter();
  const { backupUri } = useLocalSearchParams<{ backupUri?: string }>();
  const provider = useProvider();
  const { key, identity } = provider;
  const { primaryColor } = config;

  const [importText, setImportText] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);

  const handleImport = async () => {
    // Parse the input - split by spaces or newlines
    const words = importText
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0);

    if (words.length !== 24) {
      Alert.alert(
        'Invalid Phrase',
        `Expected 24 words, but found ${words.length}. Please enter your complete recovery phrase.`,
      );
      return;
    }

    // Validate using BIP39
    const phrase = words.join(' ');
    const isValid = validateMnemonic(phrase, wordlist);

    if (!isValid) {
      Alert.alert(
        'Invalid Recovery Phrase',
        'The recovery phrase you entered is not valid. Please check your words and try again.',
      );
      return;
    }

    setIsImporting(true);

    try {
      console.log('Starting import process...');

      // Clear existing keys and data to prevent duplication
      console.log('Clearing existing wallet data...');
      await key.store.clear();
      await provider.account.store.clear();
      await provider.identity.store.clear();
      await provider.passkey.store.clear();

      // Load backup if present to validate early
      let backupDoc = null;
      if (backupUri) {
        console.log('Loading backup from:', backupUri);
        backupDoc = await importDidDocument(backupUri);
      }

      // Import to the keystore
      console.log('Importing seed phrase...');
      const seedId = await key.store.import(
        {
          type: 'hd-seed',
          algorithm: 'raw',
          extractable: true,
          keyUsages: ['deriveKey', 'deriveBits'],
          privateKey: await mnemonicToSeed(phrase),
        },
        'bytes',
      );

      // Generate HD Root Key
      console.log('Generating HD Root Key...');
      const rootKeyId = await key.store.generate({
        type: 'hd-root-key',
        algorithm: 'raw',
        extractable: true,
        keyUsages: ['deriveKey', 'deriveBits'],
        params: {
          parentKeyId: seedId,
        },
      });

      if (backupDoc) {
        // Restore derived keys from backup
        console.log('Restoring from backup document...');
        await identity.store.restoreFromDidDocument(backupDoc);
        console.log('Backup restoration complete.');
      } else {
        // Default generation if no backup
        console.log('Generating default keys...');
        // Generate Ed25519 Account Key
        const accountParams = {
          parentKeyId: rootKeyId,
          context: 0,
          account: 0,
          index: 0,
          derivation: 9,
        };
        await key.store.generate({
          type: 'hd-derived-ed25519',
          algorithm: 'EdDSA',
          extractable: true,
          keyUsages: ['sign', 'verify'],
          params: {
            ...accountParams,
          },
        });

        // Generate Ed25519 Identity Key
        const identityParams = {
          parentKeyId: rootKeyId,
          context: 1,
          account: 0,
          index: 0,
          derivation: 9,
        };
        await key.store.generate({
          type: 'hd-derived-ed25519',
          algorithm: 'EdDSA',
          extractable: true,
          keyUsages: ['sign', 'verify'],
          params: {
            ...identityParams,
          },
        });
        console.log('Default key generation complete.');
      }

      // Give a small moment for extensions to process state updates before navigating
      // This helps prevent flickering on the landing screen as identities are populated
      console.log('Waiting for state synchronization...');
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Bootstrap to ensure native side is updated with new master key and keys
      await bootstrap(false);

      const { identities } = identitiesStore.state;
      const { accounts } = accountsStore.state;
      const { passkeys: providerPasskeys } = passkeysStore.state;
      console.log(
        `Import complete. Summary: identities=${identities.length}, accounts=${accounts.length}, passkeys=${providerPasskeys.length}`,
      );

      console.log('Navigating to landing...');
      router.replace('/landing');
    } catch (error) {
      console.error('Import failed:', error);
      Alert.alert(
        'Import Failed',
        'Failed to import wallet. Please check your recovery phrase and try again.',
      );
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.importContainer}>
        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.importHeader}>
            <MaterialIcons name="file-download" size={48} color={primaryColor} />
            <Text style={styles.importTitle}>Import Wallet</Text>
            <Text style={styles.importSubtitle}>
              Enter your 24-word recovery phrase to restore your wallet
            </Text>
          </View>

          <View style={styles.importInputContainer}>
            <Text style={styles.importLabel}>Recovery Phrase (24 words)</Text>
            <PreventScreenshot>
              <TextInput
                style={styles.importTextInput}
                multiline
                numberOfLines={8}
                placeholder="Enter your 24-word recovery phrase here...&#10;word1 word2 word3 ..."
                placeholderTextColor="#94A3B8"
                value={importText}
                onChangeText={setImportText}
                autoCapitalize="none"
                autoCorrect={false}
                textAlignVertical="top"
              />
            </PreventScreenshot>
            <Text style={styles.importHelper}>
              Words entered: {importText.split(/\s+/).filter((w) => w.length > 0).length} / 24
            </Text>
          </View>

          <View style={styles.importInfo}>
            <MaterialIcons name="info" size={20} color="#64748B" />
            <Text style={styles.importInfoText}>
              Your recovery phrase is only used to restore your wallet locally. It is never sent to
              any server.
            </Text>
          </View>
        </ScrollView>

        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => router.back()}
            disabled={isImporting}
          >
            <Text style={[styles.secondaryButtonText, { color: primaryColor }]}>Cancel</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.primaryButton,
              { backgroundColor: primaryColor, opacity: isImporting ? 0.7 : 1 },
            ]}
            onPress={handleImport}
            disabled={isImporting}
          >
            <Text style={styles.primaryButtonText}>
              {isImporting ? 'Importing...' : 'Import Wallet'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F0F7FF',
  },
  importContainer: {
    flex: 1,
    paddingHorizontal: 24,
  },
  scrollContent: {
    flexGrow: 1,
  },
  importHeader: {
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 30,
  },
  importTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0F172A',
    marginTop: 16,
    marginBottom: 8,
  },
  importSubtitle: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    paddingHorizontal: 20,
    lineHeight: 20,
  },
  importInputContainer: {
    marginBottom: 20,
  },
  importLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0F172A',
    marginBottom: 8,
  },
  importTextInput: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 16,
    minHeight: 180,
    fontSize: 14,
    color: '#0F172A',
    lineHeight: 22,
  },
  importHelper: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 8,
    textAlign: 'right',
  },
  importInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#F1F5F9',
    padding: 16,
    borderRadius: 12,
    marginTop: 10,
    gap: 12,
  },
  importInfoText: {
    flex: 1,
    fontSize: 13,
    color: '#64748B',
    lineHeight: 18,
  },
  buttonContainer: {
    gap: 12,
    marginTop: 20,
    paddingBottom: 20,
  },
  primaryButton: {
    paddingVertical: 16,
    borderRadius: 30,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 16,
    borderRadius: 30,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
