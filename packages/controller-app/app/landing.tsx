import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { MaterialIcons } from '@expo/vector-icons';
import Logo from '../components/Logo';
import { DidDocumentModal } from '@/dialogs/DidDocumentModal';
import { useProvider } from '@/hooks/useProvider';

// Extract provider configuration from expo-constants
const config = Constants.expoConfig?.extra?.provider || {
  name: 'Rocca',
  primaryColor: '#3B82F6',
  secondaryColor: '#E1EFFF',
  accentColor: '#10B981',
  welcomeMessage: 'Your identity, connected.',
  showAccounts: true,
  showPasskeys: true,
  showIdentities: true,
  showConnections: true,
};

export default function LandingScreen() {
  const router = useRouter();
  const { key, identity, account, identities, accounts, passkey, passkeys, sessions } =
    useProvider();
  const [modalVisible, setModalVisible] = useState(false);

  const activeIdentity = identities[0];
  const activeAccount = accounts[0];

  const {
    name,
    primaryColor,
    secondaryColor,
    accentColor,
    welcomeMessage,
    showAccounts,
    showPasskeys,
    showIdentities,
    showConnections,
  } = config;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: '#F8FAFC' }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
            <Logo size={40} />
            <View style={{ flex: 1 }}>
              <Text style={styles.welcomeText} numberOfLines={1}>
                {welcomeMessage}
              </Text>
              <Text style={styles.userName} numberOfLines={1}>
                {activeAccount
                  ? `${activeAccount.address.slice(0, 8)}...${activeAccount.address.replace('=', '').slice(-8)}`
                  : `${name} Wallet`}
              </Text>
            </View>
          </View>
          <TouchableOpacity style={styles.profileButton} onPress={() => router.push('/scan')}>
            <MaterialIcons name="qr-code-scanner" size={28} color={primaryColor} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.profileButton}>
            <MaterialIcons name="account-circle" size={32} color={primaryColor} />
          </TouchableOpacity>
        </View>

        <View style={[styles.balanceCard, { backgroundColor: primaryColor }]}>
          <View style={styles.cardHeader}>
            <Text style={styles.balanceLabel}>Total Balance</Text>
            <MaterialIcons name="visibility" size={20} color="rgba(255, 255, 255, 0.6)" />
          </View>
          <Text style={styles.balanceAmount}>
            {activeAccount ? `$${activeAccount.balance.toString()}` : '$0.00'}
          </Text>
          <View style={styles.actionButtons}>
            <TouchableOpacity style={styles.actionButton}>
              <MaterialIcons name="send" size={20} color="#FFFFFF" />
              <Text style={styles.actionButtonText}>Send</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton}>
              <MaterialIcons name="call-received" size={20} color="#FFFFFF" />
              <Text style={styles.actionButtonText}>Receive</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton}>
              <MaterialIcons name="swap-horiz" size={20} color="#FFFFFF" />
              <Text style={styles.actionButtonText}>Swap</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Your Identity (DID)</Text>
            <TouchableOpacity onPress={() => setModalVisible(true)}>
              <Text style={[styles.seeAll, { color: primaryColor }]}>View Doc</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.didCard}>
            <View style={styles.didInfo}>
              <MaterialIcons name="verified" size={20} color={accentColor} />
              <Text style={[styles.didText, { flex: 1 }]} numberOfLines={1} ellipsizeMode="middle">
                {activeIdentity?.did || 'No identity found'}
              </Text>
            </View>
            <TouchableOpacity onPress={() => alert('DID copied!')}>
              <MaterialIcons name="content-copy" size={20} color="#64748B" />
            </TouchableOpacity>
          </View>
        </View>

        {(showAccounts || showPasskeys || showIdentities || showConnections) && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Provider Services</Text>
            </View>
            <View style={styles.serviceGrid}>
              {showAccounts && (
                <TouchableOpacity
                  style={styles.serviceItem}
                  onPress={() => router.push('/accounts')}
                >
                  <View style={[styles.serviceIcon, { backgroundColor: secondaryColor }]}>
                    <MaterialIcons name="account-balance-wallet" size={28} color={primaryColor} />
                  </View>
                  <Text style={styles.serviceLabel}>Accounts</Text>
                  <Text style={styles.serviceSubLabel}>{accounts.length} Total</Text>
                </TouchableOpacity>
              )}
              {showPasskeys && (
                <TouchableOpacity
                  style={styles.serviceItem}
                  onPress={() => router.push('/passkeys')}
                >
                  <View style={[styles.serviceIcon, { backgroundColor: '#ECFDF5' }]}>
                    <MaterialIcons name="fingerprint" size={28} color="#10B981" />
                  </View>
                  <Text style={styles.serviceLabel}>Passkeys</Text>
                  <Text style={styles.serviceSubLabel}>{passkeys.length} Total</Text>
                </TouchableOpacity>
              )}
              {showIdentities && (
                <TouchableOpacity
                  style={styles.serviceItem}
                  onPress={() => router.push('/identities')}
                >
                  <View style={[styles.serviceIcon, { backgroundColor: '#FDF2F2' }]}>
                    <MaterialIcons name="person" size={28} color="#EF4444" />
                  </View>
                  <Text style={styles.serviceLabel}>Identities</Text>
                  <Text style={styles.serviceSubLabel}>{identities.length} Total</Text>
                </TouchableOpacity>
              )}
              {showConnections && (
                <TouchableOpacity
                  style={styles.serviceItem}
                  onPress={() => router.push('/connections')}
                >
                  <View style={[styles.serviceIcon, { backgroundColor: '#F1F5F9' }]}>
                    <MaterialIcons name="link" size={28} color="#64748B" />
                  </View>
                  <Text style={styles.serviceLabel}>Connections</Text>
                  <Text style={styles.serviceSubLabel}>{sessions.length} Total</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent Activity</Text>
          </View>
          <View style={styles.activityCard}>
            <View style={styles.activityItem}>
              <View style={[styles.activityIcon, { backgroundColor: '#F1F5F9' }]}>
                <MaterialIcons name="history" size={20} color="#64748B" />
              </View>
              <View style={styles.activityDetails}>
                <Text style={styles.activityTitle}>Onboarding Reward</Text>
                <Text style={styles.activityTime}>Just now</Text>
              </View>
              <Text style={[styles.activityAmount, { color: accentColor }]}>+50 pts</Text>
            </View>
          </View>
        </View>

        <TouchableOpacity
          style={styles.resetButton}
          onPress={async () => {
            await key.store.clear();
            await account.store.clear();
            await identity.store.clear();
            await passkey.store.clear();
            router.replace('/onboarding');
          }}
        >
          <Text style={styles.resetButtonText}>Logout & Reset Onboarding</Text>
        </TouchableOpacity>
      </ScrollView>

      <DidDocumentModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        didDocument={activeIdentity?.didDocument}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
    gap: 12,
  },
  welcomeText: {
    fontSize: 14,
    color: '#64748B',
    fontWeight: '500',
  },
  userName: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0F172A',
  },
  profileButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  balanceCard: {
    borderRadius: 24,
    padding: 24,
    marginBottom: 32,
    elevation: 4,
    shadowColor: '#3B82F6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  balanceLabel: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 14,
    fontWeight: '600',
  },
  balanceAmount: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '800',
    marginBottom: 24,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingVertical: 12,
    borderRadius: 16,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  section: {
    marginBottom: 32,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0F172A',
  },
  seeAll: {
    fontSize: 14,
    fontWeight: '600',
  },
  didCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  didInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  didText: {
    color: '#334155',
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '500',
  },
  serviceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  serviceItem: {
    width: '48%',
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  serviceIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  serviceLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
  },
  serviceSubLabel: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  activityCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 4,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  activityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  activityIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  activityDetails: {
    flex: 1,
  },
  activityTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0F172A',
  },
  activityTime: {
    fontSize: 12,
    color: '#94A3B8',
  },
  activityAmount: {
    fontSize: 14,
    fontWeight: '700',
  },
  resetButton: {
    marginTop: 8,
    padding: 16,
    alignItems: 'center',
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    marginVertical: 4,
  },
  resetButtonText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '500',
  },
});
