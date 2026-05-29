import React from 'react';
import { View, Text, StyleSheet, Image, ViewStyle } from 'react-native';
import Constants from 'expo-constants';

interface LogoProps {
  size?: number;
  style?: ViewStyle;
}

export default function Logo({ size = 60, style }: LogoProps) {
  const config = Constants.expoConfig?.extra?.provider || {
    name: 'Rocca',
    primaryColor: '#3B82F6',
    secondaryColor: '#E1EFFF',
  };
  const { name, primaryColor, secondaryColor, logo } = config;

  const borderRadius = size / 2;
  const fontSize = size * 0.5;

  if (logo) {
    return (
      <View style={[styles.container, { width: size, height: size }, style]}>
        <Image
          source={typeof logo === 'string' ? { uri: logo } : logo}
          style={{ width: size, height: size, borderRadius }}
          resizeMode="contain"
        />
      </View>
    );
  }

  // Fallback to UI-based logo
  return (
    <View style={[styles.container, { width: size, height: size }, style]}>
      <View
        style={[
          styles.logoCircle,
          {
            width: size,
            height: size,
            borderRadius,
            backgroundColor: secondaryColor,
            borderColor: primaryColor,
          },
        ]}
      >
        <Text style={[styles.logoText, { color: primaryColor, fontSize }]}>
          {name ? name.charAt(0) : 'R'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoCircle: {
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
  },
  logoText: {
    fontWeight: 'bold',
  },
});
