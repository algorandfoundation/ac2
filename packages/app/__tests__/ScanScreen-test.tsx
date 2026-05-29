import React from 'react';
import { render, act } from '@testing-library/react-native';
import ScanScreen from '../app/scan';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';

// Mock expo-camera
jest.mock('expo-camera', () => {
  const React = require('react');
  return {
    CameraView: (props: any) => {
      // Store the callback so we can call it manually
      React.useEffect(() => {
        if (props.onBarcodeScanned) {
          (global as any).triggerBarcodeScanned = props.onBarcodeScanned;
        }
      }, [props.onBarcodeScanned]);
      return null;
    },
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
  };
});

// Mock expo-router
jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  Stack: {
    Screen: () => null,
  },
}));

// Mock expo-linking
jest.mock('expo-linking', () => ({
  openURL: jest.fn(),
}));

// Mock useProvider hook
jest.mock('@/hooks/useProvider', () => ({
  useProvider: () => ({
    accounts: [{ address: 'ADDR123' }],
  }),
}));

// Mock MaterialIcons
jest.mock('@expo/vector-icons', () => ({
  MaterialIcons: 'MaterialIcons',
}));

// Mock Alert
import { Alert } from 'react-native';
jest.spyOn(Alert, 'alert').mockImplementation(() => {});

describe('<ScanScreen />', () => {
  const mockReplace = jest.fn();
  const mockBack = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({
      replace: mockReplace,
      back: mockBack,
    });
  });

  it('handles fido: link (lowercase)', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({ type: 'qr', data: 'fido:test' });
    });

    expect(Linking.openURL).toHaveBeenCalledWith('fido:test');
    expect(mockBack).toHaveBeenCalled();
  });

  it('handles FIDO: link (uppercase)', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({ type: 'qr', data: 'FIDO:test' });
    });

    expect(Linking.openURL).toHaveBeenCalledWith('FIDO:test');
    expect(mockBack).toHaveBeenCalled();
  });

  it('handles liquid: link (lowercase)', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({
        type: 'qr',
        data: 'liquid:test.com?requestId=123',
      });
    });

    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/chat',
      params: { origin: 'https://test.com', requestId: '123' },
    });
  });

  it('handles LIQUID: link (uppercase)', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({
        type: 'qr',
        data: 'LIQUID:test.com?requestId=123',
      });
    });

    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/chat',
      params: { origin: 'https://test.com', requestId: '123' },
    });
  });

  it('handles LIQUID:// link (uppercase)', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({
        type: 'qr',
        data: 'LIQUID://test.com?requestId=456',
      });
    });

    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/chat',
      params: { origin: 'https://test.com', requestId: '456' },
    });
  });

  it('aborts on unsupported link', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({ type: 'qr', data: 'https://google.com' });
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      expect.stringContaining('Unsupported QR code'),
    );
    expect(mockBack).toHaveBeenCalled();
  });
});
