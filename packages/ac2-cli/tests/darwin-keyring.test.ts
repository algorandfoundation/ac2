/**
 * Tests for the dedicated macOS keychain binding (`darwin-keyring.ts`).
 *
 * The unit tests inject a fake `security(1)` runner, so they run on every
 * platform and never touch a real keychain. The final suite is a real
 * roundtrip against a throwaway keychain file and only runs on macOS.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeyringBinding } from '@algorandfoundation/keystore-node';
import {
  createDarwinKeyring,
  createDefaultDarwinKeyring,
  resolveKeychainKeyPath,
  resolveKeychainPath,
  withLoginKeychainFallback,
  type SecurityResult,
  type SecurityRunner,
} from '../src/keystore/darwin-keyring.js';
import { KEYCHAIN_FILE, KEYCHAIN_KEY_FILE } from '../src/keystore/constants.js';

/** One recorded `security(1)` invocation. */
interface Call {
  args: string[];
  input?: string;
}

/** A scriptable fake `security(1)`: responds per stdin/argv command keyword. */
function fakeSecurity(
  respond: (command: string, call: Call) => SecurityResult | undefined,
): { runner: SecurityRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: SecurityRunner = (args, input) => {
    const call: Call = { args, ...(input === undefined ? {} : { input }) };
    calls.push(call);
    const command = input?.trim().split(/\s+/, 1)[0] ?? args[0] ?? '';
    return respond(command, call) ?? { status: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

const ok = (stdout = ''): SecurityResult => ({ status: 0, stdout, stderr: '' });
const notFound = (): SecurityResult => ({
  status: 44,
  stdout: '',
  stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
});

describe('createDarwinKeyring (fake security)', () => {
  let dir: string;
  let keychainPath: string;
  let secretPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ac2-darwin-keyring-'));
    keychainPath = join(dir, KEYCHAIN_FILE);
    secretPath = join(dir, KEYCHAIN_KEY_FILE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const binding = (runner: SecurityRunner): KeyringBinding =>
    createDarwinKeyring({ service: 'svc', keychainPath, secretPath, runSecurity: runner });

  it('bootstraps on first use: secret file (0600), create, settings, unlock', () => {
    const { runner, calls } = fakeSecurity((command) =>
      command === 'find-generic-password' ? notFound() : undefined,
    );
    expect(binding(runner).get('acct')).toBeNull();
    const commands = calls.map((c) => c.input?.trim().split(/\s+/, 1)[0] ?? c.args[0]);
    expect(commands.slice(0, 3)).toEqual([
      'create-keychain',
      'set-keychain-settings',
      'unlock-keychain',
    ]);
    const mode = statSync(secretPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const password = readFileSync(secretPath, 'utf8').trim();
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    // The password travels over stdin, never on an argv.
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(password);
    }
    expect(calls[0]?.input).toContain(password);
    expect(calls[2]?.input).toContain(password);
  });

  it('reuses an existing secret file and skips create when the keychain exists', () => {
    writeFileSync(secretPath, 'a'.repeat(64) + '\n', { mode: 0o600 });
    writeFileSync(keychainPath, '');
    const { runner, calls } = fakeSecurity((command) =>
      command === 'find-generic-password' ? notFound() : undefined,
    );
    expect(binding(runner).get('acct')).toBeNull();
    const commands = calls.map((c) => c.input?.trim().split(/\s+/, 1)[0] ?? c.args[0]);
    expect(commands).not.toContain('create-keychain');
    expect(calls.find((c) => c.input?.startsWith('unlock-keychain'))?.input).toContain(
      'a'.repeat(64),
    );
  });

  it('get returns the trimmed secret, null on 44, and throws on hard failures', () => {
    const responses: Record<string, SecurityResult> = {
      'find-generic-password': ok('c2VjcmV0\n'),
    };
    const { runner } = fakeSecurity((command) => responses[command]);
    const keyring = binding(runner);
    expect(keyring.get('acct')).toBe('c2VjcmV0');

    responses['find-generic-password'] = notFound();
    expect(keyring.get('acct')).toBeNull();

    responses['find-generic-password'] = { status: 1, stdout: '', stderr: 'boom' };
    expect(() => keyring.get('acct')).toThrow(/failed to read keychain entry "acct".*boom/);
  });

  it('retries a failed operation once after an explicit unlock', () => {
    let finds = 0;
    let unlocks = 0;
    const { runner } = fakeSecurity((command) => {
      if (command === 'unlock-keychain') {
        unlocks += 1;
        return ok();
      }
      if (command === 'find-generic-password') {
        finds += 1;
        return finds === 1
          ? { status: 51, stdout: '', stderr: 'User interaction is not allowed.' }
          : ok('after-unlock\n');
      }
      return undefined;
    });
    expect(binding(runner).get('acct')).toBe('after-unlock');
    expect(finds).toBe(2);
    expect(unlocks).toBe(2); // bootstrap + retry
  });

  it('set feeds the secret over stdin with -U and quoted, escaped tokens', () => {
    const { runner, calls } = fakeSecurity(() => undefined);
    binding(runner).set('a "b" \\c', 'top secret');
    const add = calls.find((c) => c.input?.startsWith('add-generic-password'));
    expect(add).toBeDefined();
    expect(add?.args).toEqual(['-i']);
    expect(add?.input).toContain('-U ');
    expect(add?.input).toContain('-s "svc"');
    expect(add?.input).toContain('-a "a \\"b\\" \\\\c"');
    expect(add?.input).toContain('-w "top secret"');
    // The secret never appears on an argv.
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain('top secret');
    }
  });

  it('set throws on failure', () => {
    const { runner } = fakeSecurity((command) =>
      command === 'add-generic-password' ? { status: 1, stdout: '', stderr: 'nope' } : undefined,
    );
    expect(() => binding(runner).set('acct', 's')).toThrow(
      /failed to write keychain entry "acct".*nope/,
    );
  });

  it('delete returns true on success and false when absent', () => {
    const responses: Record<string, SecurityResult> = { 'delete-generic-password': ok() };
    const { runner } = fakeSecurity((command) => responses[command]);
    const keyring = binding(runner);
    expect(keyring.delete('acct')).toBe(true);
    responses['delete-generic-password'] = notFound();
    expect(keyring.delete('acct')).toBe(false);
  });
});

describe('withLoginKeychainFallback', () => {
  const memory = (): KeyringBinding & { map: Map<string, string> } => {
    const map = new Map<string, string>();
    return {
      map,
      get: (account) => map.get(account) ?? null,
      set: (account, secret) => void map.set(account, secret),
      delete: (account) => map.delete(account),
    };
  };

  it('serves and migrates a legacy entry on read miss', () => {
    const primary = memory();
    const login = memory();
    login.map.set('acct', 'legacy-secret');
    const keyring = withLoginKeychainFallback(primary, { service: 'svc', login });
    expect(keyring.get('acct')).toBe('legacy-secret');
    expect(primary.map.get('acct')).toBe('legacy-secret');
  });

  it('prefers the dedicated keychain and never writes to the login keychain', () => {
    const primary = memory();
    const login = memory();
    primary.map.set('acct', 'dedicated');
    login.map.set('acct', 'legacy');
    const keyring = withLoginKeychainFallback(primary, { service: 'svc', login });
    expect(keyring.get('acct')).toBe('dedicated');
    keyring.set('other', 'value');
    expect(primary.map.get('other')).toBe('value');
    expect(login.map.has('other')).toBe(false);
  });

  it('delete clears both stores', () => {
    const primary = memory();
    const login = memory();
    login.map.set('acct', 'legacy');
    const keyring = withLoginKeychainFallback(primary, { service: 'svc', login });
    expect(keyring.delete('acct')).toBe(true);
    expect(login.map.has('acct')).toBe(false);
  });

  it('treats an unavailable login keychain as absent', () => {
    const primary = memory();
    const keyring = withLoginKeychainFallback(primary, { service: 'svc', login: null });
    expect(keyring.get('acct')).toBeNull();
  });
});

describe('createDefaultDarwinKeyring', () => {
  it('is inert off macOS', () => {
    expect(
      createDefaultDarwinKeyring({ stateDir: '/tmp/x', service: 'svc', platform: 'linux' }),
    ).toBeUndefined();
  });

  it('honours the AC2_KEYRING=login escape hatch', () => {
    expect(
      createDefaultDarwinKeyring({
        stateDir: '/tmp/x',
        service: 'svc',
        platform: 'darwin',
        env: { AC2_KEYRING: 'login' },
      }),
    ).toBeUndefined();
  });

  it('returns a dedicated-keychain binding on macOS', () => {
    const keyring = createDefaultDarwinKeyring({
      stateDir: '/tmp/x',
      service: 'svc',
      platform: 'darwin',
      env: {},
      runSecurity: () => ok(),
    });
    expect(keyring).toBeDefined();
  });
});

describe.runIf(process.platform === 'darwin')('real keychain roundtrip (macOS)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ac2-keychain-it-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates its keychain, then set/get/delete roundtrips survive re-instantiation', () => {
    const options = {
      service: 'ac2-keystore-test',
      keychainPath: resolveKeychainPath(dir),
      secretPath: resolveKeychainKeyPath(dir),
    };
    const first = createDarwinKeyring(options);

    expect(first.get('missing')).toBeNull();

    const material = 'QUJD'.repeat(256); // a chunk-sized base64 payload
    first.set('m/did:key:z6MkTest', material);
    expect(first.get('m/did:key:z6MkTest')).toBe(material);

    // Overwrite (`-U`) and an account with spaces/quotes.
    first.set('m/did:key:z6MkTest', 'dXBkYXRlZA==');
    first.set('odd "account" name', 'dg==');
    expect(first.get('m/did:key:z6MkTest')).toBe('dXBkYXRlZA==');
    expect(first.get('odd "account" name')).toBe('dg==');

    // A fresh binding (new process in real life) reuses the same keychain.
    const second = createDarwinKeyring(options);
    expect(second.get('m/did:key:z6MkTest')).toBe('dXBkYXRlZA==');

    expect(second.delete('m/did:key:z6MkTest')).toBe(true);
    expect(second.delete('m/did:key:z6MkTest')).toBe(false);
    expect(second.get('m/did:key:z6MkTest')).toBeNull();
    expect(second.delete('odd "account" name')).toBe(true);

    const mode = statSync(options.secretPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
