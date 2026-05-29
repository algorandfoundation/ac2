import { NativeModules, Platform } from 'react-native';

const { CredentialProviderModule } = NativeModules;

export interface CredentialProvider {
  isEnabledCredentialProviderService(): Promise<boolean>;
  showCredentialProviderSettings(): Promise<void>;
}

export const CredentialProviderService: CredentialProvider = {
  isEnabledCredentialProviderService: async () => {
    if (Platform.OS !== 'android') return true;
    if (!CredentialProviderModule) return true;
    return await CredentialProviderModule.isEnabledCredentialProviderService();
  },
  showCredentialProviderSettings: async () => {
    if (Platform.OS !== 'android') return;
    if (!CredentialProviderModule) return;
    return await CredentialProviderModule.showCredentialProviderSettings();
  },
};
