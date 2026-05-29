import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Alert } from 'react-native';
import * as Linking from 'expo-linking';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter, Stack } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useProvider } from '@/hooks/useProvider';

function isValidURL(urlString: string) {
  try {
    new URL(urlString);
    return true;
  } catch {
    return false;
  }
}

export default function ScanScreen() {
  const { accounts } = useProvider();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!permission) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  if (!permission) {
    // Camera permissions are still loading.
    return <View />;
  }

  if (!permission.granted) {
    // Camera permissions are not granted yet.
    return (
      <View style={styles.container}>
        <Text style={styles.message}>We need your permission to show the camera</Text>
        <TouchableOpacity onPress={requestPermission} style={styles.button}>
          <Text style={styles.buttonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const handleBarcodeScanned = async (scanningResult: { type: string; data: string }) => {
    if (scanned) return;
    setScanned(true);
    let { data } = scanningResult;

    const lowerData = data.toLowerCase();
    // Support fido: and liquid: deeplinks
    if (lowerData.startsWith('fido:')) {
      try {
        await Linking.openURL(data);
        router.back();
      } catch {
        Alert.alert('Error', 'Could not open FIDO link natively');
        router.back();
      }
      return;
    }

    if (!lowerData.startsWith('liquid:')) {
      Alert.alert('Error', 'Unsupported QR code. Only fido: and liquid: links are supported.');
      router.back();
      return;
    }

    // Handle liquid: links
    let processedData = data;
    if (lowerData.startsWith('liquid://')) {
      processedData = 'https://' + data.substring(9);
    } else if (lowerData.startsWith('liquid:')) {
      processedData = 'https://' + data.substring(7);
    }

    if (isValidURL(processedData)) {
      if (accounts.length === 0) {
        Alert.alert('Error', 'No accounts found. Please create or import an account first.');
        router.back();
        return;
      }

      const url = new URL(processedData);
      console.log('URL detected:', processedData);
      console.log('URL host:', url.host);

      // Extract requestId from query parameter or pathname
      let requestId = url.searchParams.get('requestId');
      let pathname = url.pathname;

      if (!requestId && pathname && pathname !== '/') {
        // Handle liquid://<host>/<requestId> case
        const segments = pathname.split('/').filter(Boolean);
        if (segments.length === 1) {
          requestId = segments[0];
          pathname = '/'; // Clear it from origin
        }
      }

      if (!requestId) {
        Alert.alert('Error', 'Invalid QR code: missing requestId');
        router.back();
        return;
      }

      let origin = `${url.protocol}//${url.host}`;
      if (pathname && pathname !== '/') {
        origin += pathname;
      }

      router.replace({
        pathname: '/chat',
        params: { origin, requestId },
      });
      return;
    }

    Alert.alert('Error', 'Invalid liquid link format.');
    router.back();
  };

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Scan QR Code', headerShown: false }} />
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
        barcodeScannerSettings={{
          barcodeTypes: ['qr'],
        }}
      >
        <View style={styles.overlay}>
          <TouchableOpacity style={styles.closeButton} onPress={() => router.back()}>
            <MaterialIcons name="close" size={30} color="white" />
          </TouchableOpacity>
          <View style={styles.scanAreaContainer}>
            <View style={styles.scanArea} />
            <Text style={styles.scanText}>Align QR code within the frame</Text>
          </View>
        </View>
      </CameraView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: 'black',
  },
  message: {
    textAlign: 'center',
    paddingBottom: 10,
    color: 'white',
  },
  button: {
    backgroundColor: '#3B82F6',
    padding: 12,
    borderRadius: 8,
    alignSelf: 'center',
  },
  buttonText: {
    color: 'white',
    fontWeight: 'bold',
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'space-between',
    padding: 20,
  },
  closeButton: {
    alignSelf: 'flex-start',
    marginTop: 10,
    padding: 10,
  },
  scanAreaContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanArea: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: '#3B82F6',
    backgroundColor: 'transparent',
    borderRadius: 20,
  },
  scanText: {
    color: 'white',
    marginTop: 20,
    fontSize: 16,
    fontWeight: '500',
  },
});
