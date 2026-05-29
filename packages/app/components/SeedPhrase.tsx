import React from 'react';
import { View, Text, StyleSheet, TextInput, Dimensions } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

interface SeedPhraseProps {
  recoveryPhrase: string[];
  showSeed: boolean;
  validateWords?: { [key: number]: string } | null;
  onInputChange?: (index: number, text: string) => void;
  primaryColor: string;
}

const { width } = Dimensions.get('window');

export default function SeedPhrase({
  recoveryPhrase,
  showSeed,
  validateWords = null,
  onInputChange,
  primaryColor,
}: SeedPhraseProps) {
  const renderWord = (word: string, index: number) => {
    const isTestWord = validateWords !== null && index in validateWords;
    const shouldHideWord = !showSeed && !isTestWord && validateWords === null;

    // In test mode, we "remove" non-test words by not rendering them
    if (validateWords !== null && !isTestWord) {
      return null;
    }

    return (
      <Animated.View
        key={index}
        layout={LinearTransition.duration(300)}
        entering={FadeIn.duration(300)}
        exiting={FadeOut.duration(300)}
        style={[
          styles.wordBox,
          isTestWord && styles.testWordBox,
          isTestWord && { borderColor: primaryColor },
        ]}
      >
        <Text style={styles.wordIndex}>{index + 1}.</Text>
        {isTestWord ? (
          <TextInput
            style={styles.wordInput}
            onChangeText={(text) => onInputChange?.(index, text)}
            value={validateWords[index] || ''}
            placeholder={`Word #${index + 1}`}
            autoCapitalize="none"
            autoCorrect={false}
          />
        ) : shouldHideWord ? (
          <View style={[styles.wordHidden, { backgroundColor: '#E2E8F0' }]} />
        ) : (
          <Text style={styles.wordText}>{word}</Text>
        )}
      </Animated.View>
    );
  };

  return (
    <View style={styles.container}>
      <Animated.View
        layout={LinearTransition.duration(300)}
        style={[styles.wordsGrid, { minHeight: (48 + 4) * 8 }]}
      >
        {recoveryPhrase && recoveryPhrase.length > 0
          ? recoveryPhrase.map((word, index) => renderWord(word, index))
          : // Placeholder grid during initial generation (if phrase not ready yet)
            [...Array(24)].map((_, index) => (
              <View key={index} style={styles.wordBox}>
                <Text style={styles.wordIndex}>{index + 1}.</Text>
                <View style={[styles.wordHidden, { backgroundColor: '#E2E8F0' }]} />
              </View>
            ))}

        {!showSeed && validateWords === null && (
          <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.lockOverlay}>
            <View style={[styles.lockCircle, { backgroundColor: primaryColor }]}>
              <MaterialIcons name="lock" size={32} color="#FFFFFF" />
            </View>
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 20,
  },
  wordsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
  },
  wordBox: {
    width: (width - 64) / 3, // 3 columns
    height: 48,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 4,
  },
  testWordBox: {
    width: (width - 56) / 2, // 2 columns in test mode
    height: 56,
    borderWidth: 2,
  },
  wordIndex: {
    fontSize: 10,
    color: '#94A3B8',
    width: 18,
  },
  wordText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1E293B',
  },
  wordInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#1E293B',
    padding: 0,
  },
  wordHidden: {
    flex: 1,
    height: 4,
    borderRadius: 2,
  },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(240, 247, 255, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    zIndex: 10,
  },
  lockCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
});
