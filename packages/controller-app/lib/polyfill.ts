import { fromBase64Url, toBase64URL } from '@algorandfoundation/liquid-client';
import { Passkey } from 'react-native-passkey';

function toUint8Array(buf: BufferSource): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function toArrayBuffer(base64url: string): ArrayBuffer {
  const buf = fromBase64Url(base64url).buffer;
  if (typeof SharedArrayBuffer !== 'undefined' && buf instanceof SharedArrayBuffer) {
    const newBuf = new ArrayBuffer(buf.byteLength);
    new Uint8Array(newBuf).set(new Uint8Array(buf));
    return newBuf;
  }
  return buf as ArrayBuffer;
}

export function globalPolyfill() {
  // Global unhandled promise rejection handler to catch "Unable to activate keep awake" errors
  // This is an intermittent issue with expo-keep-awake that can occur during system transitions
  // or when system dialogs (like passkeys) are active.
  if (typeof ErrorUtils !== 'undefined') {
    const originalErrorHandler = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error: any, isFatal?: boolean) => {
      const errorMessage = error?.message || (typeof error === 'string' ? error : '');
      if (errorMessage.includes('Unable to activate keep awake')) {
        console.warn('[KEEP-AWAKE ERROR CAUGHT]:', errorMessage);
        return;
      }
      // Check for nested errors in CodedError
      if (error?.cause?.message?.includes('Unable to activate keep awake')) {
        console.warn('[KEEP-AWAKE CAUSE ERROR CAUGHT]:', error.cause.message);
        return;
      }
      originalErrorHandler(error, isFatal);
    });
  }

  // React Native doesn't have a standard window.onunhandledrejection but we can still
  // try to catch them by overriding how they are handled if possible.
  // For Hermes, promise rejections that bubble up will eventually hit the global error handler.

  // @ts-ignore
  if (global?.HermesInternal?.hasPromise?.()) {
    // @ts-ignore
    const originalRejectionHandler = global.HermesInternal.getUnhandledPromiseRejectionHandler?.();
    // @ts-ignore
    global.HermesInternal.setUnhandledPromiseRejectionHandler?.((id: number, error: any) => {
      // If it's a CodedError from Expo, it might have the message in a different property or nested
      const errorMessage = error?.message || (typeof error === 'string' ? error : '');
      if (errorMessage.includes('Unable to activate keep awake')) {
        console.warn('[KEEP-AWAKE PROMISE REJECTION CAUGHT]:', errorMessage);
        return;
      }
      if (originalRejectionHandler) {
        originalRejectionHandler(id, error);
      }
    });
  }
}

export function setupNavigatorPolyfill() {
  // @ts-ignore
  if (!global.AuthenticatorAssertionResponse) {
    // @ts-ignore
    global.AuthenticatorAssertionResponse = function () {};
    // @ts-ignore
    global.AuthenticatorAssertionResponse.prototype.authenticatorData = null;
    // @ts-ignore
    global.AuthenticatorAssertionResponse.prototype.signature = null;
    // @ts-ignore
    global.AuthenticatorAssertionResponse.prototype.userHandle = null;
    // @ts-ignore
    global.AuthenticatorAssertionResponse.prototype.clientExtensionResults = null;
  }
  // @ts-ignore
  if (!global.AuthenticatorAttestationResponse) {
    // @ts-ignore
    global.AuthenticatorAttestationResponse = function () {};
    // @ts-ignore
    global.AuthenticatorAttestationResponse.prototype.attestationObject = null;
    // @ts-ignore
    global.AuthenticatorAttestationResponse.prototype.clientExtensionResults = null;
  }

  // We are monkey-patching the globals for consistency
  if (!global.navigator) {
    // @ts-expect-error, we are overriding this on purpose
    global.navigator = {};
  }

  // @ts-expect-error, we are overriding this on purpose
  global.navigator.credentials = {
    async get(obj: { publicKey?: PublicKeyCredentialRequestOptions }) {
      const publicKey = obj?.publicKey;
      if (!publicKey) return null;
      const request = {
        ...publicKey,
        challenge:
          typeof publicKey.challenge === 'string'
            ? publicKey.challenge
            : toBase64URL(toUint8Array(publicKey.challenge)),
        allowCredentials: publicKey.allowCredentials?.map((cred) => ({
          ...cred,
          id: typeof cred.id === 'string' ? cred.id : toBase64URL(toUint8Array(cred.id)),
        })),
      };
      const result = await Passkey.get(request as any);
      if (!result) return null;

      const clientDataJSON = toArrayBuffer(result.response.clientDataJSON);
      const authData = toArrayBuffer(result.response.authenticatorData);

      return {
        id: result.id,
        rawId: toArrayBuffer(result.id),
        response: {
          clientDataJSON,
          authenticatorData: authData,
          signature: toArrayBuffer(result.response.signature),
          userHandle: result.response.userHandle ? toArrayBuffer(result.response.userHandle) : null,
          clientExtensionResults: result.clientExtensionResults || {},
        },
        authenticatorAttachment: result.authenticatorAttachment,
        type: result.type,
        getClientExtensionResults: () => result.clientExtensionResults || {},
      };
    },
    async create(obj: { publicKey?: PublicKeyCredentialCreationOptions }) {
      const publicKey = obj?.publicKey;
      if (!publicKey) return null;
      const request = {
        ...publicKey,
        challenge:
          typeof publicKey.challenge === 'string'
            ? publicKey.challenge
            : toBase64URL(toUint8Array(publicKey.challenge)),
        user: {
          ...publicKey.user,
          id:
            typeof publicKey.user.id === 'string'
              ? publicKey.user.id
              : toBase64URL(toUint8Array(publicKey.user.id)),
        },
        excludeCredentials: publicKey.excludeCredentials?.map((cred) => ({
          ...cred,
          id: typeof cred.id === 'string' ? cred.id : toBase64URL(toUint8Array(cred.id)),
        })),
        authenticatorSelection: publicKey.authenticatorSelection,
        extensions: publicKey.extensions,
      };
      // Android Credential Manager is very strict about the RP ID.
      // It must match the domain where the assetlinks.json is hosted.
      const result = await Passkey.create(request as any);
      if (!result) return null;

      const clientDataJSON = toArrayBuffer(result.response.clientDataJSON);

      return {
        id: result.id,
        rawId: toArrayBuffer(result.id),
        response: {
          clientDataJSON,
          attestationObject: toArrayBuffer(result.response.attestationObject),
          getTransports: () => (result.response as any).transports || [],
          getPublicKeyAlgorithm: () => (result.response as any).publicKeyAlgorithm || -7,
          getPublicKey: () =>
            (result.response as any).publicKey
              ? toArrayBuffer((result.response as any).publicKey)
              : null,
          getAuthenticatorData: () =>
            (result.response as any).authenticatorData
              ? toArrayBuffer((result.response as any).authenticatorData)
              : null,
          clientExtensionResults: result.clientExtensionResults || {},
        },
        authenticatorAttachment: result.authenticatorAttachment,
        type: result.type,
        getClientExtensionResults: () => result.clientExtensionResults || {},
      };
    },
  };
}
