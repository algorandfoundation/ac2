import React, { useReducer, useRef, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Image,
  Modal,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { usePathname, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import Logo from '../components/Logo';
import SeedPhrase from '../components/SeedPhrase';

import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as bip39 from '@scure/bip39';
import { useProvider } from '@/hooks/useProvider';
import { mnemonicToSeed } from '@scure/bip39';
import { bootstrap } from '@/lib/bootstrap';
import { PreventScreenshot } from '@/components/PreventScreenshot';
import * as DocumentPicker from 'expo-document-picker';

// Extract provider configuration from expo-constants
const config = Constants.expoConfig?.extra?.provider || {
  name: 'Rocca',
  primaryColor: '#3B82F6',
  secondaryColor: '#E1EFFF',
};

type OnboardingStep = 'welcome' | 'generate' | 'backup' | 'verify' | 'complete';

interface State {
  step: OnboardingStep;
  recoveryPhrase: string[] | null;
  testInput: { [key: number]: string };
}

type Action =
  | { type: 'SET_PHRASE'; phrase: string[] }
  | { type: 'SHOW_PHRASE' }
  | { type: 'VERIFY_START'; indices: number[] }
  | { type: 'VERIFY'; input: { [key: number]: string } }
  | { type: 'VERIFY_SUCCESS' }
  | { type: 'RESET' };

const initialState: State = {
  step: 'welcome',
  recoveryPhrase: null,
  testInput: {},
};

function onboardingReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_PHRASE':
      return { ...state, recoveryPhrase: action.phrase, step: 'generate' };
    case 'SHOW_PHRASE':
      return { ...state, step: 'backup' };
    case 'VERIFY_START':
      return {
        ...state,
        step: 'verify',
        testInput: Object.fromEntries(action.indices.map((idx) => [idx, ''])),
      };
    case 'VERIFY':
      return { ...state, testInput: action.input };
    case 'VERIFY_SUCCESS':
      return {
        ...state,
        step: 'complete',
      };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

function getIndicatorStep(step: OnboardingStep) {
  if (step === 'welcome') return 1;
  if (step === 'generate') return 2;
  if (step === 'backup') return 2;
  if (step === 'verify') return 3;
  if (step === 'complete') return 3;
  return 0;
}

function getSecurityMessage(step: OnboardingStep) {
  switch (step) {
    case 'generate':
    case 'backup':
      return 'Write down these 24 words in order and store them in a safe offline place. Do not take a screenshot.';
    case 'verify':
      return 'Enter the requested words from your phrase to confirm you have a correct backup.';
    default:
      return 'Your recovery phrase is the only way to recover your wallet. Keep it secret and never share it.';
  }
}

export default function OnboardingScreen() {
  // UI Elements
  const { primaryColor, secondaryColor, name } = config;
  const scrollViewRef = useRef<ScrollView>(null);
  const [showImportOptions, setShowImportOptions] = useState(false);

  // Expo Router for Navigation
  const router = useRouter();
  // Provider Context, used to hold global states and interfaces
  const { keys, key, account, identity, passkey } = useProvider();
  // State reducer
  const [{ step, recoveryPhrase, testInput }, dispatch] = useReducer(
    onboardingReducer,
    initialState,
  );

  const pathname = usePathname();

  useEffect(() => {
    // Only auto-navigate to landing if we are on the welcome step AND this is the active route
    // This prevents interrupting the /import flow which is pushed on top of this screen.
    if (keys.length > 0 && step === 'welcome' && pathname === '/onboarding') {
      router.replace('/landing');
    }
  }, [keys, step, pathname, router]);

  // Helpers for state
  const currentIndicatorStep = getIndicatorStep(step);
  const securityMessage = getSecurityMessage(step);
  const isBackupVerified = step === 'complete';
  const isPhraseVisible = step === 'backup';
  const showTest = step === 'verify';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.headerIndicator}>
        {/* Step Indicator */}
        {currentIndicatorStep > 0 && (
          <View style={styles.stepIndicator}>
            {[1, 2, 3].map((s) => (
              <View
                key={s}
                style={[
                  styles.stepDot,
                  currentIndicatorStep === s && [
                    styles.stepDotActive,
                    { backgroundColor: primaryColor },
                  ],
                  currentIndicatorStep > s && [
                    styles.stepDotCompleted,
                    { backgroundColor: secondaryColor },
                  ],
                ]}
              />
            ))}
            <Text style={styles.stepText}>Step {currentIndicatorStep} of 3</Text>
          </View>
        )}
      </View>

      <View style={styles.content}>
        {step === 'welcome' ? (
          /* Step 1: Welcome */
          <View style={styles.welcomeContainer}>
            <ScrollView
              ref={scrollViewRef}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.welcomeHeader}>
                <Logo style={styles.logoContainer} size={80} />
                <Text style={styles.title}>Welcome to {name}</Text>
                <Text style={styles.subtitle}>
                  Your secure, decentralized identity for connecting and managing your digital life.
                </Text>
              </View>

              <View style={styles.illustrationContainer}>
                <Image
                  source={require('../assets/images/onboarding.png')}
                  style={styles.onboardingGraphic}
                  resizeMode="contain"
                />
              </View>
            </ScrollView>

            <View style={styles.buttonContainer}>
              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: primaryColor }]}
                onPress={() => {
                  if (keys.length > 0) {
                    router.replace('/landing');
                    return;
                  }

                  // Update onboarding to include the text, this is used to validate the list
                  const phrase = bip39.generateMnemonic(wordlist, 256).split(' ');
                  dispatch({ type: 'SET_PHRASE', phrase });

                  // Scroll to the button once generation is complete
                  setTimeout(() => {
                    scrollViewRef.current?.scrollToEnd({ animated: true });
                  }, 100);
                }}
              >
                <Text style={styles.primaryButtonText}>Create Wallet</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => setShowImportOptions(true)}
              >
                <Text style={[styles.secondaryButtonText, { color: primaryColor }]}>
                  Import Existing Wallet
                </Text>
              </TouchableOpacity>
            </View>

            {/* Import Options Modal */}
            <Modal
              visible={showImportOptions}
              transparent={true}
              animationType="fade"
              onRequestClose={() => setShowImportOptions(false)}
            >
              <TouchableOpacity
                style={styles.modalOverlay}
                activeOpacity={1}
                onPress={() => setShowImportOptions(false)}
              >
                <View style={styles.modalContent}>
                  <Text style={styles.modalTitle}>Import Options</Text>

                  <TouchableOpacity
                    style={styles.optionButton}
                    onPress={() => {
                      setShowImportOptions(false);
                      router.push('/import');
                    }}
                  >
                    <View style={[styles.optionIcon, { backgroundColor: secondaryColor }]}>
                      <MaterialIcons name="text-fields" size={24} color={primaryColor} />
                    </View>
                    <View style={styles.optionTextContainer}>
                      <Text style={styles.optionLabel}>Recovery Phrase</Text>
                      <Text style={styles.optionSubLabel}>
                        Import using your 24-word secret phrase
                      </Text>
                    </View>
                    <MaterialIcons name="chevron-right" size={24} color="#CBD5E1" />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.optionButton}
                    onPress={async () => {
                      setShowImportOptions(false);
                      try {
                        const result = await DocumentPicker.getDocumentAsync({
                          type: 'application/json',
                          copyToCacheDirectory: true,
                        });

                        if (result.canceled) return;

                        const file = result.assets[0];
                        // Just navigate to import with the backup URI
                        router.push({
                          pathname: '/import',
                          params: { backupUri: file.uri },
                        });
                      } catch (error) {
                        Alert.alert(
                          'Error',
                          error instanceof Error ? error.message : 'Unknown error',
                        );
                      }
                    }}
                  >
                    <View style={[styles.optionIcon, { backgroundColor: '#ECFDF5' }]}>
                      <MaterialIcons name="backup" size={24} color="#10B981" />
                    </View>
                    <View style={styles.optionTextContainer}>
                      <Text style={styles.optionLabel}>Restore from Backup</Text>
                      <Text style={styles.optionSubLabel}>
                        Recover from a previously exported file
                      </Text>
                    </View>
                    <MaterialIcons name="chevron-right" size={24} color="#CBD5E1" />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.modalCancelButton}
                    onPress={() => setShowImportOptions(false)}
                  >
                    <Text style={styles.modalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            </Modal>
          </View>
        ) : (
          /* Step 2: Secure Your Identity (Generating, Backup, Verify) */
          <View style={styles.onboardingContainer}>
            <ScrollView
              ref={scrollViewRef}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.header}>
                <Text style={styles.title}>Secure Your Identity.</Text>
              </View>

              <View style={styles.illustrationContainer}>
                <Logo size={100} />
              </View>

              <View style={styles.infoSection}>
                <Text style={styles.infoTitle}>
                  {isBackupVerified ? 'Identity Secured!' : 'Secure Your Recovery Phrase'}
                </Text>

                {isBackupVerified ? (
                  <Animated.View entering={FadeIn.duration(400)} style={styles.successAnimation}>
                    <View style={[styles.successCircle, { backgroundColor: primaryColor }]}>
                      <MaterialIcons name="check" size={60} color="#FFFFFF" />
                    </View>
                  </Animated.View>
                ) : (
                  <Animated.View
                    key={step}
                    entering={FadeIn.duration(400)}
                    exiting={FadeOut.duration(400)}
                    style={styles.securityWarning}
                  >
                    <MaterialIcons name="security" size={20} color={primaryColor} />
                    <Text style={styles.securityWarningText}>{securityMessage}</Text>
                  </Animated.View>
                )}
              </View>

              {!isBackupVerified && (
                <PreventScreenshot enabled={isPhraseVisible}>
                  <SeedPhrase
                    recoveryPhrase={recoveryPhrase || []}
                    showSeed={isPhraseVisible}
                    validateWords={showTest ? testInput : null}
                    onInputChange={(index, text) =>
                      dispatch({ type: 'VERIFY', input: { ...testInput, [index]: text } })
                    }
                    primaryColor={primaryColor}
                  />
                </PreventScreenshot>
              )}
            </ScrollView>

            {!isBackupVerified && (
              <View style={styles.buttonContainer}>
                {(() => {
                  switch (step) {
                    case 'generate':
                      return (
                        <>
                          <TouchableOpacity
                            style={styles.secondaryButton}
                            onPress={() => dispatch({ type: 'RESET' })}
                          >
                            <Text style={[styles.secondaryButtonText, { color: primaryColor }]}>
                              Go Back
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.primaryButton, { backgroundColor: primaryColor }]}
                            onPress={() => dispatch({ type: 'SHOW_PHRASE' })}
                          >
                            <Text style={styles.primaryButtonText}>View Secret</Text>
                          </TouchableOpacity>
                        </>
                      );
                    case 'backup':
                      return (
                        <TouchableOpacity
                          style={[styles.primaryButton, { backgroundColor: primaryColor }]}
                          onPress={() => {
                            // TODO: randomize
                            const indices = [3, 7, 15, 21];
                            dispatch({ type: 'VERIFY_START', indices });
                          }}
                        >
                          <Text style={styles.primaryButtonText}>Verify Recovery Phrase</Text>
                        </TouchableOpacity>
                      );
                    case 'verify':
                      return (
                        <>
                          <TouchableOpacity
                            style={styles.secondaryButton}
                            onPress={() => dispatch({ type: 'RESET' })}
                          >
                            <Text style={[styles.secondaryButtonText, { color: primaryColor }]}>
                              Reset Onboarding
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.primaryButton, { backgroundColor: primaryColor }]}
                            onPress={async () => {
                              const isCorrect = Object.entries(testInput).every(
                                ([index, value]) =>
                                  value.toLowerCase().trim() === recoveryPhrase?.[Number(index)],
                              );
                              if (isCorrect) {
                                dispatch({ type: 'VERIFY_SUCCESS' });
                                if (recoveryPhrase === null) {
                                  throw new Error('Recovery phrase is null');
                                }

                                // Clear existing keys and data to prevent duplication
                                await key.store.clear();
                                await account.store.clear();
                                await identity.store.clear();
                                await passkey.store.clear();

                                // Import to the keystore
                                const seedId = await key.store.import(
                                  {
                                    type: 'hd-seed',
                                    algorithm: 'raw',
                                    extractable: true,
                                    keyUsages: ['deriveKey', 'deriveBits'],
                                    privateKey: await mnemonicToSeed(recoveryPhrase.join(' ')),
                                  },
                                  'bytes',
                                );

                                // Generate HD Root Key
                                const rootKeyId = await key.store.generate({
                                  type: 'hd-root-key',
                                  algorithm: 'raw',
                                  extractable: true,
                                  keyUsages: ['deriveKey', 'deriveBits'],
                                  params: {
                                    parentKeyId: seedId,
                                  },
                                });

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

                                // Bootstrap to ensure native side is updated with new master key and keys
                                await bootstrap(undefined, false);

                                router.replace('/landing');
                              } else {
                                Alert.alert(
                                  'Verification Failed',
                                  "The words you entered don't match your recovery phrase. Would you like to try again or start over?",
                                  [
                                    { text: 'Try Again', style: 'cancel' },
                                    {
                                      text: 'Start Over',
                                      onPress: () => dispatch({ type: 'RESET' }),
                                      style: 'destructive',
                                    },
                                  ],
                                );
                              }
                            }}
                          >
                            <Text style={styles.primaryButtonText}>Check Words</Text>
                          </TouchableOpacity>
                        </>
                      );
                    default:
                      return (
                        <TouchableOpacity
                          style={[styles.primaryButton, { backgroundColor: primaryColor }]}
                          onPress={() => router.replace('/landing')}
                        >
                          <Text style={styles.primaryButtonText}>Complete onboarding</Text>
                        </TouchableOpacity>
                      );
                  }
                })()}
              </View>
            )}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F0F7FF',
  },
  scrollContent: {
    flexGrow: 1,
  },
  stepIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    gap: 8,
  },
  headerIndicator: {
    paddingTop: 4,
  },
  stepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#CBD5E1',
  },
  stepDotActive: {
    width: 24,
  },
  stepDotCompleted: {
    backgroundColor: '#93C5FD',
  },
  stepText: {
    marginLeft: 8,
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 20,
    flex: 1,
  },
  welcomeContainer: {
    flex: 1,
  },
  welcomeHeader: {
    alignItems: 'center',
    marginTop: 10,
  },
  logoContainer: {
    marginBottom: 24,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#0F172A',
    textAlign: 'center',
    marginBottom: 16,
  },
  subtitle: {
    fontSize: 16,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 24,
    paddingHorizontal: 10,
    marginBottom: 20,
  },
  onboardingContainer: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    marginTop: 0,
    marginBottom: 20,
  },
  illustrationContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 30,
    minHeight: 150,
  },
  onboardingGraphic: {
    width: '100%',
    height: 250,
  },
  infoSection: {
    alignItems: 'center',
    marginBottom: 20,
  },
  infoTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0F172A',
    textAlign: 'center',
    marginBottom: 12,
  },
  successAnimation: {
    marginVertical: 20,
    alignItems: 'center',
  },
  successCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  securityWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFBEB',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FEF3C7',
    marginTop: 5,
    gap: 10,
  },
  securityWarningText: {
    flex: 1,
    fontSize: 13,
    color: '#92400E',
    lineHeight: 18,
  },
  buttonContainer: {
    gap: 12,
    marginTop: 20,
    paddingBottom: 10,
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
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 24,
  },
  optionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  optionIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  optionTextContainer: {
    flex: 1,
  },
  optionLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0F172A',
  },
  optionSubLabel: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 2,
  },
  modalCancelButton: {
    marginTop: 8,
    paddingVertical: 16,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#64748B',
  },
});
