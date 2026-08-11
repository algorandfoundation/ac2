/**
 * Tests for the hardened `@napi-rs/keyring` binding
 * (`src/keystore/napi-keyring.ts`): `get()` must map only a genuine
 * "no such entry" to `null` and rethrow hard keychain failures (Secret
 * Service unreachable, keychain locked, …) — never mask them as "absent",
 * or the driver would regenerate its metadata master key over the real one.
 */

import { describe, it, expect } from 'vitest';
import {
  createHardenedNapiKeyring,
  isNoEntryError,
  type NapiKeyringModule,
} from '../src/keystore/napi-keyring.js';

/** An in-memory `@napi-rs/keyring` stand-in with programmable failures. */
function fakeModule(options: {
  entries?: Map<string, string>;
  getError?: Error;
  deleteError?: Error;
}): NapiKeyringModule {
  const entries = options.entries ?? new Map<string, string>();
  return {
    Entry: class {
      constructor(
        private readonly service: string,
        private readonly account: string,
      ) {}
      private key(): string {
        return `${this.service}\u0000${this.account}`;
      }
      getPassword(): string | null {
        if (options.getError) throw options.getError;
        return entries.get(this.key()) ?? null;
      }
      setPassword(password: string): void {
        entries.set(this.key(), password);
      }
      deletePassword(): boolean {
        if (options.deleteError) throw options.deleteError;
        return entries.delete(this.key());
      }
    },
  };
}

describe('isNoEntryError', () => {
  it('recognizes the NoEntry display strings of the keyring crates', () => {
    expect(isNoEntryError(new Error('No matching entry found in secure storage'))).toBe(true);
    expect(isNoEntryError(new Error('No matching credential found'))).toBe(true);
    expect(isNoEntryError('No matching entry found in secure storage')).toBe(true);
  });

  it('treats every other failure as hard', () => {
    expect(isNoEntryError(new Error('Platform secure storage failure: zbus error'))).toBe(false);
    expect(isNoEntryError(new Error('The collection is locked'))).toBe(false);
    expect(isNoEntryError(new Error(''))).toBe(false);
  });
});

describe('createHardenedNapiKeyring', () => {
  it('round-trips set → get → delete through the injected module', () => {
    const keyring = createHardenedNapiKeyring({ service: 'ac2-test', module: fakeModule({}) });
    expect(keyring.get('svc')).toBeNull();
    keyring.set('svc', 'secret');
    expect(keyring.get('svc')).toBe('secret');
    expect(keyring.delete('svc')).toBe(true);
    expect(keyring.delete('svc')).toBe(false);
    expect(keyring.get('svc')).toBeNull();
  });

  it('maps a genuine NoEntry error from get() to null', () => {
    const keyring = createHardenedNapiKeyring({
      service: 'ac2-test',
      module: fakeModule({ getError: new Error('No matching entry found in secure storage') }),
    });
    expect(keyring.get('svc')).toBeNull();
  });

  it('rethrows hard get() failures with the account and the Secret Service hint', () => {
    const keyring = createHardenedNapiKeyring({
      service: 'ac2-test',
      module: fakeModule({
        getError: new Error('Platform secure storage failure: no Secret Service provider'),
      }),
    });
    expect(() => keyring.get('svc')).toThrow(/failed to read OS keychain entry "svc"/);
    expect(() => keyring.get('svc')).toThrow(/no Secret Service provider/);
    expect(() => keyring.get('svc')).toThrow(/running Secret Service/);
  });

  it('treats delete() failures as "nothing deleted"', () => {
    const keyring = createHardenedNapiKeyring({
      service: 'ac2-test',
      module: fakeModule({ deleteError: new Error('The collection is locked') }),
    });
    expect(keyring.delete('svc')).toBe(false);
  });
});
