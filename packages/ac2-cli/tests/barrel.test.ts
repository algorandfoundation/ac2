import { describe, expect, it } from 'vitest';

import {
  createAc2KeyStore,
  decideControllerBinding,
  migrateLegacyKeystore,
  resolveControlSocketPath,
} from '../src/index.js';

describe('ac2-cli barrel', () => {
  it('exposes the moved identity, keystore, and control exports', () => {
    expect(typeof decideControllerBinding).toBe('function');
    expect(typeof createAc2KeyStore).toBe('function');
    expect(typeof migrateLegacyKeystore).toBe('function');
    expect(typeof resolveControlSocketPath).toBe('function');
  });

  it('decideControllerBinding registers a first-time controller', () => {
    expect(
      decideControllerBinding({
        boundControllerDid: undefined,
        connectedAccountDid: 'did:key:zController',
        hasStoredIdentity: false,
      }),
    ).toBe('register');
  });

  it('resolveControlSocketPath resolves a default path under $AC2_HOME', () => {
    const path = resolveControlSocketPath({ ...process.env, AC2_HOME: '/tmp/ac2-home' });
    expect(path).toBe('/tmp/ac2-home/ac2d.sock');
  });
});
