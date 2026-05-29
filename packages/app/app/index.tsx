import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Redirect } from 'expo-router';
import Constants from 'expo-constants';
import { useStore } from '@tanstack/react-store';
import { logsStore } from '@/stores/logs';
import Logo from '@/components/Logo';
import { useProvider } from '@/hooks/useProvider';
export default function Index() {
  const { keys, status } = useProvider();
  const logs = useStore(logsStore, (state) => state.logs);
  const lastLog = logs.length > 0 ? logs[0].message : 'Initializing...';

  const config = Constants.expoConfig?.extra?.provider || {
    primaryColor: '#3B82F6',
  };

  if (status === 'loading') {
    return (
      <View style={styles.container}>
        <Logo size={100} style={styles.logo} />
        <ActivityIndicator size="large" color={config.primaryColor} />
        <View style={styles.content}>
          <Text style={styles.text}>{lastLog}</Text>
          <Text style={styles.subtext}>Securing your keys and passkeys</Text>
        </View>
      </View>
    );
  }

  if (keys.length > 0) return <Redirect href="/landing" />;
  return <Redirect href="/onboarding" />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    padding: 24,
  },
  logo: {
    marginBottom: 40,
  },
  content: {
    marginTop: 24,
    alignItems: 'center',
  },
  text: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1E293B',
    textAlign: 'center',
  },
  subtext: {
    marginTop: 8,
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
  },
});
