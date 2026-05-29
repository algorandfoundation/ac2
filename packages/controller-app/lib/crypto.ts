import {
  ACCESS_CONTROL,
  ACCESSIBLE,
  getGenericPassword,
  type GetOptions,
  getSupportedBiometryType,
  canImplyAuthentication,
  setGenericPassword,
  type SetOptions,
  resetGenericPassword,
  getSecurityLevel,
  isPasscodeAuthAvailable,
} from 'react-native-keychain';
import { Platform } from 'react-native';
import { createCipheriv, createDecipheriv, randomBytes } from 'react-native-quick-crypto';
import type { AuthenticationOptions } from '@algorandfoundation/react-native-keystore';

const ALGORITHM = 'aes-256-gcm';

/**
 * Retrieves the master key from the Keychain, or generates a new one if it doesn't exist.
 * @returns The master key as a Buffer
 */
export async function getMasterKey(options?: AuthenticationOptions): Promise<Buffer> {
  const prompt =
    typeof options?.prompt === 'string'
      ? options.prompt
      : typeof options?.prompt === 'object' && (options.prompt as any)?.title
        ? (options.prompt as any).title
        : 'Authenticate to secure your wallet';

  const biometryType = await getSupportedBiometryType();
  const enrolled = Platform.OS === 'ios' ? await canImplyAuthentication() : true;
  const securityLevel = await getSecurityLevel();
  const passcodeAvailable = await isPasscodeAuthAvailable();

  console.log(
    `[Crypto INFO] Biometric diagnostics: Platform: ${Platform.OS}, Type: ${biometryType}, Enrolled (iOS only): ${enrolled}, SecurityLevel: ${securityLevel}, PasscodeAvailable: ${passcodeAvailable}`,
  );

  const canUseBiometry = biometryType !== null && enrolled;

  if (options?.biometrics && !canUseBiometry) {
    console.error(
      `[Crypto ERROR] Biometric authentication is requested but not available or enrolled (Type: ${biometryType}, Enrolled: ${enrolled}).`,
    );
    throw new Error('Biometric authentication is requested but not available or enrolled.');
  }

  const getOptions: GetOptions = {
    service: 'app-secret-key',
  };

  if (options?.biometrics) {
    getOptions.accessControl = ACCESS_CONTROL.BIOMETRY_ANY;
    getOptions.authenticationPrompt = prompt;
  }

  console.log(
    `[Crypto INFO] Local retrieval starting. Biometrics requested: ${options?.biometrics}, Available: ${canUseBiometry}`,
  );

  // Try to get existing key
  try {
    const credentials = await getGenericPassword(getOptions);

    if (credentials) {
      console.log('[Crypto INFO] getGenericPassword succeeded!');
      return Buffer.from(credentials.password, 'hex');
    }
    console.log('[Crypto INFO] getGenericPassword returned false (no credentials)');
  } catch (e: any) {
    const errorMsg = String(e);
    if (errorMsg.includes('CryptoFailedException')) {
      console.warn(
        '[Crypto WARN] Detected stale/corrupt Keychain data (CryptoFailedException). Resetting...',
      );
      await resetGenericPassword(getOptions);
    } else {
      console.error(`[Crypto ERROR] getGenericPassword error: ${e}`);
      throw e;
    }
  }

  // Create new random key
  const newKey = randomBytes(32);
  const setOptions: SetOptions = {
    service: 'app-secret-key',
  };

  if (options?.biometrics) {
    setOptions.accessControl = ACCESS_CONTROL.BIOMETRY_ANY;
    setOptions.accessible = ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
    setOptions.authenticationPrompt = prompt;
  }

  console.log('[Crypto INFO] Saving new master key...');
  try {
    // Explicitly reset before setting a new key to avoid stale data conflicts
    await resetGenericPassword(setOptions);
    await setGenericPassword('master', newKey.toString('hex'), setOptions);
    console.log('[Crypto INFO] New master key saved successfully');
  } catch (e) {
    console.error(`[Crypto ERROR] setGenericPassword error: ${e}`);
    throw e;
  }

  return Buffer.from(newKey);
}

/**
 * Encrypts data using AES-256-GCM with the provided key.
 * @param key - The encryption key
 * @param data - The string data to encrypt
 * @returns A JSON string containing IV, Auth Tag, and encrypted content
 */
export const encryptData = (key: Buffer, data: string): string => {
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(data, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  // Return a combined payload
  return JSON.stringify({
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    content: encrypted,
  });
};

/**
 * Decrypts data using AES-256-GCM with the provided key and payload.
 * @param key - The decryption key
 * @param payloadStr - The JSON string containing IV, Auth Tag, and content
 * @returns The decrypted string
 */
export const decryptData = (key: Buffer, payloadStr: string): string => {
  const { iv, tag, content } = JSON.parse(payloadStr);

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64') as any);

  let decrypted = decipher.update(content, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
};
