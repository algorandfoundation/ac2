# Rocca Wallet Sample

This project demonstrates an onboarding flow for a white-label identity solution.

## White-Label Configuration

The application is designed as a white-label solution. You can customize the branding and features by modifying the `extra.provider` section in `app.config.js`:

```json
{
  "extra": {
    "provider": {
      "name": "Aura",
      "primaryColor": "#3B82F6",
      "secondaryColor": "#E1EFFF",
      "accentColor": "#10B981",
      "welcomeMessage": "Your identity, rewarded."
    }
  }
}
```

These values are consumed by the app via `expo-constants`.

## Screen Flow

The application uses `expo-router` for navigation. The flow is automatically determined by the presence of cryptographic keys:

1. **Index (`/`)**: Initial entry point that redirects to either Onboarding or Landing based on the wallet's initialization state.
2. **Onboarding (`/onboarding`)**: A multi-step flow for new users:
   - **Welcome**: Introduction to the white-label provider.
   - **Generate**: Creation of the 24-word recovery phrase and initial DID keys.
   - **Backup**: Secure display of the recovery phrase for user backup.
   - **Verify**: Verification step to ensure the user has correctly backed up their phrase.
3. **Landing (`/landing`)**: The main dashboard for onboarded users, featuring:
   - Identity (DID) management.

   > [!NOTE]
   > The landing dashboard currently contains placeholder data and UI components as a mock for future implementation.

## Architecture

The application is built on the `@algorandfoundation/wallet-provider` architecture, which uses a modular `Extension` system to augment a `Provider` with specific capabilities.

```typescript
import { Provider } from '@algorandfoundation/wallet-provider';

export class MyProvider extends Provider<typeof MyProvider.EXTENSIONS> {
  static EXTENSIONS = [
    WithKeyStore,
    WithAccountStore,
    // ... other extensions
  ] as const;
}
```

## Extensions

The following extensions are used to provide the wallet's functionality:

### 1. KeyStore Extension (`@algorandfoundation/react-native-keystore`)

- **Purpose**: Securely manage private keys and cryptographic material using device-native security (Keychain/Keystore).
- **Functionality**:
  - `keys`: List of available keys.
  - `key.store.generate(options: GenerateOptions)`: Create new keys (e.g., Ed25519).
  - `key.store.sign(keyId: string, data: Uint8Array)`: Sign transactions or challenges.
  - `key.store.exportPublicKey(keyId: string)`: Retrieve public keys.

### 2. AccountStore Extension (`@algorandfoundation/accounts-store`)

- **Purpose**: Manages a list of user accounts and their metadata.
- **Functionality**:
  - `accounts`: List of available accounts.
  - `account.store.addAccount(account: Account)`: Register a new account.
  - `account.store.getAccount(address: string)`: Retrieve an account by address.
  - `account.store.removeAccount(address: string)`: Remove an account.
  - `account.store.clear()`: Remove all accounts.

### 3. AccountsKeystore Extension (`@algorandfoundation/accounts-keystore-extension`)

- **Purpose**: Bridges the AccountStore and KeyStore.
- **Functionality**:
  - Automatically populates the AccountStore when keys are added to the KeyStore.
  - Provides a `sign` method on account objects that leverages the KeyStore backend.

### 4. LogStore Extension (`@algorandfoundation/log-store`)

- **Purpose**: Provides a centralized store for application logs and events.
- **Functionality**:
  - `logs`: List of application logs.
  - `log.info(message: string)`: Add an information log entry.
  - `log.warn(message: string)`: Add a warning log entry.
  - `log.error(message: string)`: Add an error log entry.
  - `log.clear()`: Remove all log entries.

## Suggested Extensions (New)

To further integrate with identity primitives, the following extensions are suggested:

### 1. DID Extension

- **Purpose**: Handle Decentralized Identifier operations.
- **Functionality**:
  - `createDID(publicKey: string)`: Generate a DID string (e.g., `did:key:z...`).
  - `resolveDID(did: string)`: Fetch the DID Document associated with an identifier.

### 2. Provider Extension

- **Purpose**: Interface with the centralized "Provider" for rewards and fee delegation.
- **Functionality**:
  - `getRewards(account: string)`: Fetch pending rewards for the user.
  - `requestFeeDelegation(transaction: Transaction)`: Submit a transaction to the provider for co-signing/fee payment.
  - `onboard(did: string)`: Register the new DID with the provider's white-label system.

## Getting Started

1. Install dependencies

   ```bash
   pnpm install
   ```

2. Start the app on Android

> [!IMPORTANT]
> This project contains native dependencies (like `react-native-quick-crypto` and `@algorandfoundation/react-native-keystore`) that require running on a physical Android device. It may not function correctly on an emulator.
>
> Ensure you have your Android device connected and authorized via ADB, then run:
>
> ```bash
> pnpm android
> ```
