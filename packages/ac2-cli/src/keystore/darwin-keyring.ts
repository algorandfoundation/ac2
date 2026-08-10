/**
 * A macOS keyring binding over a **dedicated keychain file** owned by AC2.
 *
 * The default binding (`@napi-rs/keyring`) files everything in the user's
 * *login* keychain. That works in a GUI session, but the AC2 daemon is a
 * background process: under launchd (`ac2 service install`), over SSH, or
 * before login the login keychain is locked and macOS cannot show the unlock
 * prompt, so every access fails with `errSecInteractionNotAllowed` ("User
 * interaction is not allowed."). Since AC2's keys are only ever used by the
 * daemon itself, they live in a private keychain instead:
 *
 * - The keychain file (`ac2-keystore.keychain-db`) sits in the AC2 state dir
 *   next to the sealed metadata blob; its password is random and kept in a
 *   `0600` secret file (`ac2-keystore.keychain-key`) in the same directory.
 * - The daemon creates and unlocks the keychain itself via `/usr/bin/security`,
 *   so no user interaction is ever required — pairing works headless.
 * - Auto-lock is disabled (`set-keychain-settings` with no timeout), and every
 *   operation retries once after an explicit unlock in case the keychain was
 *   locked externally (e.g. after a reboot).
 * - Secrets never appear on an argv: commands that carry the keychain password
 *   or an entry's material are fed to `security -i` over stdin.
 *
 * The binding is synchronous (the upstream driver requires it) and shells out
 * with `spawnSync`; keystore operations are rare, so the cost is irrelevant.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { KeyringBinding } from '@algorandfoundation/keystore-node';
import { KEYCHAIN_FILE, KEYCHAIN_KEY_FILE } from './constants.js';

/** `errSecItemNotFound` / `errSecDuplicateKeychain` as `security(1)` exit codes. */
const EXIT_NOT_FOUND = 44;
const EXIT_DUPLICATE_KEYCHAIN = 48;

/** Outcome of one `security(1)` invocation. */
export interface SecurityResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs `security(1)`; injectable so tests never touch a real keychain. */
export type SecurityRunner = (args: string[], input?: string) => SecurityResult;

/** Options for {@link createDarwinKeyring}. */
export interface DarwinKeyringOptions {
  /** OS-keychain service every entry is filed under. */
  service: string;
  /** Absolute path of the dedicated keychain file. */
  keychainPath: string;
  /** Absolute path of the `0600` file holding the keychain password. */
  secretPath: string;
  /** Inject a `security(1)` runner — tests use a fake. */
  runSecurity?: SecurityRunner;
  /** Progress / diagnostics sink. */
  log?: (line: string) => void;
}

/** Absolute path of the dedicated keychain file for `stateDir`. */
export function resolveKeychainPath(stateDir: string): string {
  return join(stateDir, KEYCHAIN_FILE);
}

/** Absolute path of the keychain-password secret file for `stateDir`. */
export function resolveKeychainKeyPath(stateDir: string): string {
  return join(stateDir, KEYCHAIN_KEY_FILE);
}

const defaultRunner: SecurityRunner = (args, input) => {
  const result = spawnSync('/usr/bin/security', args, {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/** Quotes a token for `security -i`'s command parser. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Creates a {@link KeyringBinding} over a dedicated, self-unlocked macOS
 * keychain file. See the module doc for the full design.
 */
export function createDarwinKeyring(options: DarwinKeyringOptions): KeyringBinding {
  const { service, keychainPath, secretPath } = options;
  const run = options.runSecurity ?? defaultRunner;
  const log = options.log ?? ((): void => {});

  let password: string | null = null;
  let ready = false;

  /** Feeds one command (with secrets) to `security -i` over stdin. */
  const runStdin = (command: string): SecurityResult => run(['-i'], `${command}\n`);

  const readOrCreatePassword = (): string => {
    if (password) return password;
    mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 });
    try {
      password = readFileSync(secretPath, 'utf8').trim();
    } catch {
      password = null;
    }
    if (!password) {
      password = randomBytes(32).toString('hex');
      writeFileSync(secretPath, `${password}\n`, { mode: 0o600 });
    }
    // The password is the only thing standing between an attacker with file
    // access and the key material — never leave it group/world readable.
    chmodSync(secretPath, 0o600);
    return password;
  };

  const unlock = (): void => {
    const pw = readOrCreatePassword();
    const result = runStdin(`unlock-keychain -p ${quote(pw)} ${quote(keychainPath)}`);
    if (result.status !== 0) {
      throw new Error(
        `[ac2] failed to unlock the AC2 keychain (${keychainPath}): ${result.stderr.trim()}`,
      );
    }
  };

  const ensureReady = (): void => {
    if (ready) return;
    const pw = readOrCreatePassword();
    if (!existsSync(keychainPath)) {
      const created = runStdin(`create-keychain -p ${quote(pw)} ${quote(keychainPath)}`);
      if (created.status === 0) {
        log(`[ac2] created dedicated keychain ${keychainPath}`);
      } else if (created.status !== EXIT_DUPLICATE_KEYCHAIN) {
        throw new Error(
          `[ac2] failed to create the AC2 keychain (${keychainPath}): ${created.stderr.trim()}`,
        );
      }
    }
    // No `-l`/`-u`: never auto-lock, so the daemon unlocks once per process.
    run(['set-keychain-settings', keychainPath]);
    unlock();
    ready = true;
  };

  /** Runs `operation`, retrying once after an explicit unlock. */
  const withUnlockRetry = (operation: () => SecurityResult): SecurityResult => {
    ensureReady();
    let result = operation();
    if (result.status !== 0 && result.status !== EXIT_NOT_FOUND) {
      unlock();
      result = operation();
    }
    return result;
  };

  return {
    get(account: string): string | null {
      const result = withUnlockRetry(() =>
        run(['find-generic-password', '-s', service, '-a', account, '-w', keychainPath]),
      );
      if (result.status === EXIT_NOT_FOUND) return null;
      if (result.status !== 0) {
        // Never mask a hard failure as "absent": the driver would regenerate
        // its metadata master key and orphan every stored entry.
        throw new Error(
          `[ac2] failed to read keychain entry "${account}": ${result.stderr.trim()}`,
        );
      }
      return result.stdout.replace(/\n$/, '');
    },
    set(account: string, secret: string): void {
      const result = withUnlockRetry(() =>
        runStdin(
          `add-generic-password -U -s ${quote(service)} -a ${quote(account)} ` +
            `-w ${quote(secret)} ${quote(keychainPath)}`,
        ),
      );
      if (result.status !== 0) {
        throw new Error(
          `[ac2] failed to write keychain entry "${account}": ${result.stderr.trim()}`,
        );
      }
    },
    delete(account: string): boolean {
      const result = withUnlockRetry(() =>
        run(['delete-generic-password', '-s', service, '-a', account, keychainPath]),
      );
      return result.status === 0;
    },
  };
}

/**
 * Wraps `primary` with a best-effort, lazy **read** fallback to the login
 * keychain: entries written by earlier AC2 versions (which used the default
 * `@napi-rs/keyring` binding) are copied into the dedicated keychain the first
 * time they are read, so existing pairings survive the switch. Writes and
 * deletes always target the dedicated keychain; login-keychain failures (e.g.
 * headless sessions where it is locked) are treated as "absent".
 */
export function withLoginKeychainFallback(
  primary: KeyringBinding,
  options: {
    /** OS-keychain service the legacy entries were filed under. */
    service: string;
    /** Progress / diagnostics sink. */
    log?: (line: string) => void;
    /** Inject the legacy binding — tests use a fake. */
    login?: KeyringBinding | null;
  },
): KeyringBinding {
  const { service } = options;
  const log = options.log ?? ((): void => {});
  let login: KeyringBinding | null | undefined = options.login;

  const loginBinding = (): KeyringBinding | null => {
    if (login !== undefined) return login;
    try {
      const require = createRequire(import.meta.url);
      const { Entry } = require('@napi-rs/keyring') as {
        Entry: new (
          service: string,
          account: string,
        ) => { getPassword(): string; deletePassword(): boolean };
      };
      login = {
        get(account: string): string | null {
          try {
            return new Entry(service, account).getPassword();
          } catch {
            return null;
          }
        },
        set(): void {},
        delete(account: string): boolean {
          try {
            return new Entry(service, account).deletePassword();
          } catch {
            return false;
          }
        },
      };
    } catch {
      login = null;
    }
    return login;
  };

  return {
    get(account: string): string | null {
      const existing = primary.get(account);
      if (existing !== null) return existing;
      const legacy = loginBinding()?.get(account) ?? null;
      if (legacy !== null) {
        try {
          primary.set(account, legacy);
          log(`[ac2] migrated keychain entry "${account}" from the login keychain`);
        } catch {
          // Migration is best-effort — serving the value still works.
        }
      }
      return legacy;
    },
    set(account: string, secret: string): void {
      primary.set(account, secret);
    },
    delete(account: string): boolean {
      const deleted = primary.delete(account);
      const legacyDeleted = loginBinding()?.delete(account) ?? false;
      return deleted || legacyDeleted;
    },
  };
}

/** Options for {@link createDefaultDarwinKeyring}. */
export interface DefaultDarwinKeyringOptions {
  stateDir: string;
  service: string;
  /** Injectable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  runSecurity?: SecurityRunner;
  log?: (line: string) => void;
}

/**
 * The default keyring for {@link createAc2KeyStore} when the caller injects
 * none: on macOS a dedicated AC2 keychain (with the login-keychain read
 * fallback), elsewhere `undefined` so the upstream default applies. Setting
 * `AC2_KEYRING=login` restores the old login-keychain behaviour.
 */
export function createDefaultDarwinKeyring(
  options: DefaultDarwinKeyringOptions,
): KeyringBinding | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'darwin') return undefined;
  if (env['AC2_KEYRING']?.trim() === 'login') return undefined;
  const log = options.log ?? ((): void => {});
  const dedicated = createDarwinKeyring({
    service: options.service,
    keychainPath: resolveKeychainPath(options.stateDir),
    secretPath: resolveKeychainKeyPath(options.stateDir),
    ...(options.runSecurity ? { runSecurity: options.runSecurity } : {}),
    log,
  });
  return withLoginKeychainFallback(dedicated, { service: options.service, log });
}
