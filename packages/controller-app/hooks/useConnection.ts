import { useProvider } from '@/hooks/useProvider';
import { accountsStore } from '@/stores/accounts';
import { keyStore } from '@/stores/keystore';
import { addMessage } from '@/stores/messages';
import {
  addSession,
  Session,
  sessionsStore,
  updateSessionActivity,
  updateSessionStatus,
} from '@/stores/sessions';
import { decodeAddress } from '@/utils/algorand';
import { toUrlSafe } from '@/utils/base64';
import type { KeyData } from '@algorandfoundation/keystore';
import { encodeAddress } from '@algorandfoundation/keystore';
import {
  decodeAssertionRequestOptions,
  encodeCredential,
  fromBase64Url,
  SignalClient,
  toBase64URL,
} from '@algorandfoundation/liquid-client';
import { commit, fetchSecret, getMasterKey } from '@algorandfoundation/react-native-keystore';
import { useStore } from '@tanstack/react-store';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, NativeModules } from 'react-native';

interface UseConnectionResult {
  session: Session | undefined;
  address: string | null;
  send: (text: string) => void;
  error: Error | null;
  isError: boolean;
  isLoading: boolean;
  isConnected: boolean;
  lastHeartbeat: number;
  reset: () => void;
}

export function useConnection(origin: string, requestId: string): UseConnectionResult {
  const router = useRouter();
  const { accounts, keys, key, passkey, sessions } = useProvider();

  const [isConnected, setIsConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const addressRef = useRef<string | null>(null);

  useEffect(() => {
    addressRef.current = address;
  }, [address]);

  const [lastHeartbeat, setLastHeartbeat] = useState<number>(Date.now());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const clientRef = useRef<SignalClient | null>(null);
  const lastUserActivityRef = useRef<number>(Date.now());
  const authFlowInProgressRef = useRef<boolean>(false);

  const session = useStore(sessionsStore, (state) =>
    state.sessions.find((s) => s.id === requestId && s.origin === origin),
  );

  const reset = useCallback(() => {
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    setIsConnected(false);
    setIsLoading(false);
    setError(null);
    updateSessionStatus(requestId, origin, 'closed');
  }, [requestId, origin]);

  const send = useCallback(
    (text: string) => {
      if (
        text.trim() &&
        dataChannelRef.current &&
        dataChannelRef.current.readyState === 'open' &&
        address
      ) {
        dataChannelRef.current.send(text.trim());
        addMessage({
          text: text.trim(),
          sender: 'me',
          address,
          origin,
          requestId,
        });
        updateSessionActivity(requestId, origin);
        lastUserActivityRef.current = Date.now();
      }
    },
    [requestId, origin, address],
  );

  useEffect(() => {
    let active = true;
    let heartbeatInterval: any = null;
    let inactivityInterval: any = null;

    if (isConnected) {
      heartbeatInterval = setInterval(() => {
        if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
          console.log('Sending heartbeat message');
          dataChannelRef.current.send('');
          if (active) setLastHeartbeat(Date.now());
        }
      }, 20000);

      inactivityInterval = setInterval(() => {
        const now = Date.now();
        const inactiveTime = now - lastUserActivityRef.current;
        if (inactiveTime >= 60000) {
          console.log('Closing connection due to inactivity (1 minute)');
          if (dataChannelRef.current) {
            dataChannelRef.current.close();
          }
          if (active) {
            setIsConnected(false);
            router.back();
          }
        }
      }, 5000);
    }

    return () => {
      active = false;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (inactivityInterval) clearInterval(inactivityInterval);
    };
  }, [isConnected, router]);

  useEffect(() => {
    let active = true;

    async function setupConnection() {
      if (!origin || !requestId) {
        console.error('Missing origin or requestId');
        setIsLoading(false);
        return;
      }

      if (authFlowInProgressRef.current) {
        console.log('Auth flow already in progress, skipping duplicate setup');
        return;
      }

      if (accountsStore.state.accounts.length === 0 || keyStore.state.keys.length === 0) {
        console.log('Waiting for accounts and keys to load...');
        // If it's been loading for more than a few seconds, it might really be empty
        // but typically it's better to wait for them to be non-empty.
        return;
      }

      // If we are already connecting or connected, don't start again
      if (clientRef.current || isConnected) {
        return;
      }

      setIsLoading(true);
      setError(null);
      authFlowInProgressRef.current = true;

      try {
        const currentSessions = sessionsStore.state.sessions;
        const currentKeys = keyStore.state.keys;
        const currentAccounts = accountsStore.state.accounts;

        const existingSession = currentSessions.find(
          (s) => s.id === requestId && s.origin === origin,
        );
        if (!existingSession) {
          addSession({ id: requestId, origin, status: 'active', ttl: 60000 });
        } else if (existingSession.status !== 'active') {
          updateSessionStatus(requestId, origin, 'active');
        }

        // Try to find the key associated with the first account, but fall back to the first available key
        let foundKey = currentKeys.find((k) => k.id === currentAccounts[0]?.metadata?.keyId);
        if (!foundKey && currentKeys.length > 0) {
          foundKey = currentKeys[0];
          console.log('Falling back to the first available key for attestation');
        }

        if (!foundKey || !foundKey.publicKey) {
          console.error(
            'No key found for attestation. Keys:',
            JSON.stringify(
              currentKeys.map((k) => ({ id: k.id, type: k.type })),
              null,
              2,
            ),
          );
          console.error(
            'Accounts:',
            JSON.stringify(
              currentAccounts.map((a) => ({ address: a.address, keyId: a.metadata?.keyId })),
              null,
              2,
            ),
          );
          throw new Error('No key found for attestation');
        }

        console.log('Found key for attestation:', foundKey.id, foundKey.type);

        const sessionCheck = await fetch(`${origin}/auth/session`);
        if (!active) return;
        console.log('Initial session status:', sessionCheck.ok);

        const currentPasskeys = await passkey.store.getPasskeys();
        const relevantPasskeys = currentPasskeys.filter((p) => {
          const storedOrigin = p.metadata?.origin;
          if (!storedOrigin) return false;
          try {
            const storedHost = storedOrigin.includes('://')
              ? new URL(storedOrigin).host
              : storedOrigin;
            const currentHost = origin.includes('://') ? new URL(origin).host : origin;
            return storedHost === currentHost;
          } catch {
            return storedOrigin === origin;
          }
        });

        if (relevantPasskeys.length > 0) {
          const firstPasskey = relevantPasskeys[0];
          console.log(
            'Found existing passkeys for origin, using first one for options request:',
            firstPasskey.id,
          );
          // TODO: move options upstream
          const optionsResponse = await fetch(`${origin}/assertion/request/${firstPasskey.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userVerification: 'required',
            }),
          });

          if (!active) return;

          if (!optionsResponse.ok) {
            throw new Error(
              `Failed to get assertion request: ${optionsResponse.status} ${optionsResponse.statusText}`,
            );
          }

          const options = await optionsResponse.json();
          if (!active) return;
          const decodedOptions = decodeAssertionRequestOptions(options);

          // Ensure all relevant passkeys are allowed in the options to allow user selection in the intent
          if (relevantPasskeys.length > 1) {
            if (!decodedOptions.allowCredentials) {
              decodedOptions.allowCredentials = [];
            }
            const existingIds = new Set(
              decodedOptions.allowCredentials.map((c) =>
                toBase64URL(new Uint8Array(c.id as ArrayBuffer)),
              ),
            );
            relevantPasskeys.forEach((p) => {
              if (!existingIds.has(p.id)) {
                decodedOptions.allowCredentials!.push({
                  id: fromBase64Url(p.id),
                  type: 'public-key',
                });
              }
            });
          }

          const challenge = fromBase64Url(options.challenge);

          const liquidOptions = {
            requestId,
            origin,
            type: 'algorand',
            address: encodeAddress(foundKey?.publicKey),
            signature: toBase64URL(await key.store.sign(foundKey.id, challenge)),
            device: 'Demo Web Wallet',
          };

          const credential = (await navigator.credentials.get({
            publicKey: decodedOptions,
          })) as any;
          if (!active) return;
          authFlowInProgressRef.current = false;

          if (!credential) {
            throw new Error('Credential creation failed');
          }

          const currentPasskeys = await passkey.store.getPasskeys();
          let selectedAddress: string | null = null;
          if (credential.response?.userHandle) {
            try {
              selectedAddress = encodeAddress(new Uint8Array(credential.response.userHandle));
            } catch (e) {
              console.error('Failed to encode address from userHandle', e);
            }
          }

          if (!selectedAddress) {
            const matchedPasskey =
              relevantPasskeys.find((p) => p.id === credential.id) ||
              currentPasskeys.find((p) => p.id === credential.id);
            const userHandle = matchedPasskey?.metadata?.userHandle;
            if (userHandle) {
              try {
                // Handle different possible formats of userHandle in store (Uint8Array or serialized object)
                const handleArray =
                  userHandle instanceof Uint8Array
                    ? userHandle
                    : typeof userHandle === 'object'
                      ? new Uint8Array(Object.values(userHandle))
                      : null;
                if (handleArray) {
                  selectedAddress = encodeAddress(handleArray);
                }
              } catch (e) {
                console.error('Failed to encode address from stored userHandle', e);
              }
            }
          }

          if (selectedAddress) {
            console.log('Selected address from passkey:', selectedAddress);
            setAddress(selectedAddress);
            addressRef.current = selectedAddress;
            liquidOptions.address = selectedAddress;

            // Re-sign the challenge if the address changed to match the selected passkey
            const selectedPublicKey = decodeAddress(selectedAddress).publicKey;
            const selectedKey = keyStore.state.keys.find(
              (k) =>
                k.publicKey &&
                k.publicKey.length === selectedPublicKey.length &&
                k.publicKey.every((v, i) => v === selectedPublicKey[i]),
            );

            if (selectedKey) {
              console.log('Found key for selected address, re-signing challenge');
              liquidOptions.signature = toBase64URL(
                await key.store.sign(selectedKey.id, challenge),
              );
            } else {
              console.warn('Could not find key for selected address', selectedAddress);
            }
          }

          const encodedCredential = encodeCredential(credential);
          //@ts-ignore
          encodedCredential.clientExtensionResults = {
            //@ts-ignore
            ...encodedCredential.clientExtensionResults,
            liquid: liquidOptions,
          };

          const submitResponse = await fetch(`${origin}/assertion/response`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(encodedCredential),
          });

          if (!submitResponse.ok) {
            throw new Error(
              `Failed to submit assertion response: ${submitResponse.status} ${submitResponse.statusText}`,
            );
          }

          const matchedPasskey = currentPasskeys.find((p) => p.id === credential.id);
          const matchedKey =
            keyStore.state.keys.find((k) => k.id === matchedPasskey?.metadata?.keyId) ||
            keyStore.state.keys.find((k) => toUrlSafe(k.id) === credential.id);

          if (matchedKey) {
            try {
              const masterKey = await getMasterKey();
              const keyData = await fetchSecret<KeyData>({ keyId: matchedKey.id, masterKey });
              if (keyData) {
                keyData.metadata = { ...keyData.metadata, registered: true };
                await commit({ store: keyStore as any, keyData });
              }
            } catch (error) {
              console.error('Failed to update key metadata after assertion:', error);
            }
          }
        } else {
          console.log('No existing passkey for origin, using attestation');

          const optionsResponse = await fetch(`${origin}/attestation/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              attestationType: 'none',
              authenticatorSelection: {
                authenticatorAttachment: 'platform',
                userVerification: 'required',
                residentKey: 'required',
                requireResidentKey: true,
              },
              extensions: {
                liquid: true,
              },
            }),
          });

          if (!active) return;

          if (!optionsResponse.ok) {
            throw new Error(
              `Failed to get attestation request: ${optionsResponse.status} ${optionsResponse.statusText}`,
            );
          }

          const encodedAttestationOptions = await optionsResponse.json();
          if (!active) return;
          const challenge = fromBase64Url(encodedAttestationOptions.challenge);

          const liquidOptions = {
            requestId,
            origin: origin,
            type: 'algorand',
            address: encodeAddress(foundKey?.publicKey),
            signature: toBase64URL(await key.store.sign(foundKey.id, challenge)),
            device: 'Demo Web Wallet',
          };

          const decodedPublicKey = {
            ...encodedAttestationOptions,
            user: {
              ...encodedAttestationOptions.user,
              id: decodeAddress(liquidOptions.address).publicKey,
              name: liquidOptions.address,
              displayName: liquidOptions.address,
            },
            challenge: fromBase64Url(encodedAttestationOptions.challenge),
            excludeCredentials: encodedAttestationOptions.excludeCredentials?.map((cred: any) => ({
              ...cred,
              id: fromBase64Url(cred.id),
            })),
          };

          const credential = (await navigator.credentials.create({
            publicKey: decodedPublicKey,
          })) as any;
          if (!active) return;
          authFlowInProgressRef.current = false;

          if (!credential) {
            throw new Error('Credential creation failed');
          }

          setAddress(liquidOptions.address);
          addressRef.current = liquidOptions.address;

          const response = credential.response;
          const encodedCredential = {
            id: credential.id,
            rawId: toBase64URL(credential.rawId),
            type: credential.type,
            response: {
              clientDataJSON: toBase64URL(response.clientDataJSON),
              attestationObject: toBase64URL(response.attestationObject),
              clientExtensionResults: response.clientExtensionResults || {},
            },
            clientExtensionResults: {
              ...(credential.getClientExtensionResults
                ? credential.getClientExtensionResults()
                : credential.clientExtensionResults || {}),
              liquid: liquidOptions,
            },
          };

          const submitResponse = await fetch(`${origin}/attestation/response`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(encodedCredential),
          });

          if (!active) return;

          if (!submitResponse.ok) {
            throw new Error(
              `Failed to submit attestation response: ${submitResponse.status} ${submitResponse.statusText}`,
            );
          }

          const currentPasskeys = await passkey.store.getPasskeys();
          const matchedPasskey = currentPasskeys.find((p) => p.id === credential.id);
          const matchedKey =
            keyStore.state.keys.find((k) => k.id === matchedPasskey?.metadata?.keyId) ||
            keyStore.state.keys.find((k) => toUrlSafe(k.id) === credential.id);

          if (matchedKey) {
            try {
              const masterKey = await getMasterKey();
              const keyData = await fetchSecret<KeyData>({ keyId: matchedKey.id, masterKey });
              if (keyData) {
                keyData.metadata = { ...keyData.metadata, registered: true };
                await commit({ store: keyStore as any, keyData });
              }
            } catch (error) {
              console.error('Failed to update key metadata after attestation:', error);
            }
          }
        }

        // Final validation of the session before connecting
        const finalSessionCheck = await fetch(`${origin}/auth/session`);

        if (!active) return;

        if (finalSessionCheck.ok) {
          const sessionData = await finalSessionCheck.json();

          if (!active) return;

          if (sessionData.address) {
            setAddress(sessionData.address);
            addressRef.current = sessionData.address;
          }
        } else {
          console.log('Session validation failed (ignored for debugging)');
        }

        let options: any = { autoConnect: true };
        if (NativeModules.CookieModule) {
          const cookie = await NativeModules.CookieModule.getCookie(origin);

          if (!active) return;

          if (cookie) {
            options.extraHeaders = { Cookie: cookie };
          }
        }

        const client = new SignalClient(origin, options);

        if (!active) return;

        clientRef.current = client;
        //@ts-ignore
        client.authenticated = true;

        const datachannel = await client.peer(requestId, 'answer', {
          iceServers: [
            {
              urls: ['stun:geo.turn.algonode.xyz:80', 'stun:global.turn.nodely.io:443'],
            },
            {
              urls: [
                'turn:geo.turn.algonode.xyz:80?transport=tcp',
                'turns:global.turn.nodely.io:443?transport=tcp',
              ],
              username: 'liquid-auth',
              credential: 'sqmcP4MiTKMT4TGEDSk9jgHY',
            },
          ],
        });

        if (!active) {
          client.close();
          return;
        }

        dataChannelRef.current = datachannel;

        datachannel.onopen = () => {
          console.log('Data channel opened');
          if (active) {
            setIsConnected(true);
            setIsLoading(false);
            updateSessionStatus(requestId, origin, 'active');
          }
        };

        datachannel.onmessage = (event) => {
          if (!active) return;
          console.log('Received message:', event.data);
          updateSessionActivity(requestId, origin);
          lastUserActivityRef.current = Date.now();
          setLastHeartbeat(Date.now());
          if (event.data && event.data.trim() && addressRef.current) {
            addMessage({
              text: event.data.trim(),
              sender: 'peer',
              address: addressRef.current,
              origin,
              requestId,
            });
          }
        };

        datachannel.onclose = () => {
          console.log('Data channel closed');
          updateSessionStatus(requestId, origin, 'closed');
          if (active) {
            setIsConnected(false);
            router.back();
          }
        };

        datachannel.onerror = (error) => {
          console.error('Data channel error:', error);
        };
      } catch (err: any) {
        console.error('Failed to setup connection:', err);
        clientRef.current = null;
        updateSessionStatus(requestId, origin, 'failed');
        if (active) {
          setError(err);
          setIsLoading(false);
          Alert.alert(
            'Connection Failed',
            err.message || 'Failed to setup connection to the peer',
            [{ text: 'OK', onPress: () => router.back() }],
          );
        }
      } finally {
        authFlowInProgressRef.current = false;
      }
    }

    setupConnection();

    return () => {
      active = false;
      if (dataChannelRef.current) {
        dataChannelRef.current.close();
        dataChannelRef.current = null;
      }
      if (clientRef.current) {
        clientRef.current.close();
        clientRef.current = null;
      }
    };
  }, [origin, requestId, router, accounts.length > 0, keys.length > 0]);

  return {
    session,
    address,
    send,
    error,
    isError: !!error,
    isLoading,
    isConnected,
    lastHeartbeat,
    reset,
  };
}
