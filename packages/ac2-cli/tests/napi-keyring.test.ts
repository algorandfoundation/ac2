/**
 * Tests for the hardened `@napi-rs/keyring` binding
 * (`src/keystore/napi-keyring.ts`): `get()` must map only a genuine
 * "no such entry" to `null` and rethrow hard keychain failures (Secret
 * Service unreachable, keychain locked, …) — never mask them as "absent",
 * or the driver would regenerate its metadata master key over the real one.
 */

import { describe, it, expect } from 'vitest';
import type { KeyringBinding } from '@algorandfoundation/keystore-node';
import {
  assertPersistentKeyStorage,
  createHardenedNapiKeyring,
  ensureSessionBusAddress,
  isNoEntryError,
  type NapiKeyringModule,
} from '../src/keystore/napi-keyring.js';

/** An in-memory `@napi-rs/keyring` stand-in with programmable failures. */
function fakeModule(options: {
  entries?: Map<string, string>;
  getError?: Error;
  setError?: Error;
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
        if (options.setError) throw options.setError;
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

  it('rethrows set() failures with the account and the headless hint', () => {
    // What a headless box hits first: the Secret Service answers on the bus
    // but has no unlocked keyring to write into.
    const keyring = createHardenedNapiKeyring({
      service: 'ac2-test',
      module: fakeModule({
        setError: new Error("Couldn't access platform storage: Secret Service: no result found"),
      }),
    });
    expect(() => keyring.set('svc', 'secret')).toThrow(/failed to write OS keychain entry "svc"/);
    expect(() => keyring.set('svc', 'secret')).toThrow(/Secret Service: no result found/);
    expect(() => keyring.set('svc', 'secret')).toThrow(/Headless keyring/);
  });

  it('treats delete() failures as "nothing deleted"', () => {
    const keyring = createHardenedNapiKeyring({
      service: 'ac2-test',
      module: fakeModule({ deleteError: new Error('The collection is locked') }),
    });
    expect(keyring.delete('svc')).toBe(false);
  });
});

describe('ensureSessionBusAddress', () => {
  it('fills in the systemd user bus when the variable is missing (headless SSH session)', () => {
    const env: NodeJS.ProcessEnv = {};
    const address = ensureSessionBusAddress({
      platform: 'linux',
      env,
      uid: 1001,
      exists: (path) => path === '/run/user/1001/bus',
    });
    expect(address).toBe('unix:path=/run/user/1001/bus');
    expect(env['DBUS_SESSION_BUS_ADDRESS']).toBe('unix:path=/run/user/1001/bus');
  });

  it('never overwrites an address the session already exports', () => {
    const env: NodeJS.ProcessEnv = {
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/custom/bus',
    };
    expect(
      ensureSessionBusAddress({
        platform: 'linux',
        env,
        uid: 1001,
        exists: () => true,
      }),
    ).toBeNull();
    expect(env['DBUS_SESSION_BUS_ADDRESS']).toBe('unix:path=/custom/bus');
  });

  it('leaves the environment untouched when there is no user bus socket', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(
      ensureSessionBusAddress({
        platform: 'linux',
        env,
        uid: 1001,
        exists: () => false,
      }),
    ).toBeNull();
    expect(env['DBUS_SESSION_BUS_ADDRESS']).toBeUndefined();
  });

  it('is a no-op on non-Linux platforms', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(
      ensureSessionBusAddress({
        platform: 'darwin',
        env,
        uid: 501,
        exists: () => true,
      }),
    ).toBeNull();
    expect(env['DBUS_SESSION_BUS_ADDRESS']).toBeUndefined();
  });
});

describe('assertPersistentKeyStorage', () => {
  /** A recording {@link KeyringBinding} stand-in for probe behavior. */
  function fakeKeyring(options: { setError?: Error } = {}): KeyringBinding & {
    calls: string[];
    entries: Map<string, string>;
  } {
    const entries = new Map<string, string>();
    const calls: string[] = [];
    return {
      calls,
      entries,
      get(account: string): string | null {
        calls.push(`get:${account}`);
        return entries.get(account) ?? null;
      },
      set(account: string, secret: string): void {
        calls.push(`set:${account}`);
        if (options.setError) throw options.setError;
        entries.set(account, secret);
      },
      delete(account: string): boolean {
        calls.push(`delete:${account}`);
        return entries.delete(account);
      },
    };
  }

  it('is a no-op on non-Linux platforms', () => {
    const keyring = fakeKeyring();
    assertPersistentKeyStorage(keyring, { platform: 'darwin' });
    assertPersistentKeyStorage(keyring, { platform: 'win32' });
    expect(keyring.calls).toEqual([]);
  });

  it('rejects the volatile kernel keyring (probe visible in /proc/keys) and cleans up', () => {
    const keyring = fakeKeyring();
    let probeAccount = '';
    expect(() =>
      assertPersistentKeyStorage(keyring, {
        platform: 'linux',
        readProcKeys: () => {
          probeAccount = keyring.calls[0]!.slice('set:'.length);
          return `3985ad4c I--Q---  1 perm 3f010000  1000  1000 user  keyring:svc@${probeAccount}: 5\n`;
        },
      }),
    ).toThrow(/kernel session keyring/);
    expect(probeAccount).toMatch(/^ac2-keyring-probe-/);
    // The probe entry is removed even on failure.
    expect(keyring.calls.at(-1)).toBe(`delete:${probeAccount}`);
    expect(keyring.entries.size).toBe(0);
  });

  it('passes when the probe does not land in the kernel keyring and cleans up', () => {
    const keyring = fakeKeyring();
    assertPersistentKeyStorage(keyring, {
      platform: 'linux',
      readProcKeys: () => 'deadbeef I--Q---  1 perm 3f010000  0  0 keyring  _ses: empty\n',
    });
    expect(keyring.calls[0]).toMatch(/^set:ac2-keyring-probe-/);
    expect(keyring.calls.at(-1)).toMatch(/^delete:ac2-keyring-probe-/);
    expect(keyring.entries.size).toBe(0);
  });

  it('is inconclusive (does not block) when /proc/keys is unreadable', () => {
    const keyring = fakeKeyring();
    assertPersistentKeyStorage(keyring, {
      platform: 'linux',
      readProcKeys: () => {
        throw new Error('EACCES');
      },
    });
    expect(keyring.entries.size).toBe(0);
  });

  it('propagates a hard probe-write failure (e.g. locked Secret Service)', () => {
    const keyring = fakeKeyring({
      setError: new Error('The collection is locked'),
    });
    expect(() =>
      assertPersistentKeyStorage(keyring, {
        platform: 'linux',
        readProcKeys: () => '',
      }),
    ).toThrow(/collection is locked/);
  });
});
