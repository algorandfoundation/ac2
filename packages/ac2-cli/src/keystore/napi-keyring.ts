/**
 * A hardened `@napi-rs/keyring` binding for the platforms that use the OS
 * keychain directly (Linux Secret Service, Windows Credential Manager, and
 * macOS with `AC2_KEYRING=login`).
 *
 * The keystore engine's built-in default binding (`createNapiKeyring` in
 * `@algorandfoundation/keystore-node`) historically masked EVERY `get()`
 * error as "no entry": a locked or unreachable keychain surfaced as a missing
 * key — or worse, let the driver mint a fresh metadata master key over the
 * real one and orphan every stored entry. The upstream default has been fixed,
 * but until `ac2-cli` picks up a release containing that fix, this module
 * injects the same contract locally (mirroring `createDarwinKeyring`, which
 * documents it: never mask a hard failure as "absent").
 *
 * Like the upstream binding, the native addon is loaded lazily so importing
 * this module never eagerly pulls in `@napi-rs/keyring`.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { KeyringBinding } from '@algorandfoundation/keystore-node';

/** The subset of `@napi-rs/keyring`'s `Entry` the binding uses. */
interface NapiEntry {
  /** Returns `null` when no entry exists; throws on a hard keychain failure. */
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

/** The subset of the `@napi-rs/keyring` module the binding uses. */
export interface NapiKeyringModule {
  Entry: new (service: string, account: string) => NapiEntry;
}

/** Options for {@link createHardenedNapiKeyring}. */
export interface HardenedNapiKeyringOptions {
  /** OS-keychain service every entry is filed under. */
  service: string;
  /** Inject the `@napi-rs/keyring` module — test seam only. */
  module?: NapiKeyringModule;
}

/**
 * Whether a `@napi-rs/keyring` error genuinely means "no such entry", as
 * opposed to a hard failure (Secret Service unreachable, keychain locked,
 * access denied, …). Matches the `NoEntry` display strings of the underlying
 * `keyring`/`keyring-core` crates; current releases return `null` from
 * `getPassword()` instead of throwing, so most builds never reach this check.
 */
export function isNoEntryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('No matching entry found in secure storage') ||
    message.includes('No matching credential found')
  );
}

/**
 * Creates a {@link KeyringBinding} over `@napi-rs/keyring` that distinguishes
 * "no such entry" from a hard keychain failure. See the module doc for why
 * this exists alongside the upstream default.
 */
export function createHardenedNapiKeyring(options: HardenedNapiKeyringOptions): KeyringBinding {
  const { service } = options;
  const load = (): NapiKeyringModule => {
    if (options.module) return options.module;
    const require = createRequire(import.meta.url);
    return require('@napi-rs/keyring') as NapiKeyringModule;
  };
  let module: NapiKeyringModule | null = null;
  const entry = (account: string): NapiEntry => {
    module ??= load();
    return new module.Entry(service, account);
  };

  return {
    get(account: string): string | null {
      try {
        return entry(account).getPassword();
      } catch (error) {
        // Only a genuine "no such entry" maps to absent. Never mask a hard
        // failure as `null`: the driver would report its master key as
        // missing — or regenerate the metadata master key over the real one
        // and orphan every stored entry.
        if (isNoEntryError(error)) return null;
        throw new Error(
          `[ac2] failed to read OS keychain entry "${account}": ` +
            `${error instanceof Error ? error.message : String(error)} — the OS keychain ` +
            'may be locked or unavailable (on Linux this requires a running Secret Service ' +
            'daemon, e.g. gnome-keyring, with an unlocked login keyring).',
        );
      }
    },
    set(account: string, secret: string): void {
      try {
        entry(account).setPassword(secret);
      } catch (error) {
        // A write failure is what a headless box hits first (the Secret
        // Service is on the bus but its keyring was never created/unlocked,
        // e.g. `Couldn't access platform storage: Secret Service: no result
        // found`). Keep the cause, add the fix — the raw crate message names
        // neither the entry nor what to do about it.
        throw new Error(
          `[ac2] failed to write OS keychain entry "${account}": ` +
            `${error instanceof Error ? error.message : String(error)} — the OS keychain ` +
            'may be locked or unavailable (on Linux this requires a running Secret Service ' +
            'daemon, e.g. gnome-keyring, with an unlocked login keyring; on a headless ' +
            'machine see "Headless keyring" in the AC2 troubleshooting guide).',
        );
      }
    },
    delete(account: string): boolean {
      try {
        return entry(account).deletePassword();
      } catch {
        return false;
      }
    },
  };
}

/** Options for {@link ensureSessionBusAddress}. */
export interface SessionBusOptions {
  /** Platform override — test seam only (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** Environment to inspect and mutate (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Uid override — test seam only (defaults to `process.getuid()`). */
  uid?: number;
  /** Path existence check — test seam only. */
  exists?: (path: string) => boolean;
}

/**
 * Point `DBUS_SESSION_BUS_ADDRESS` at the caller's systemd user bus when it is
 * not already set, so the Secret Service can be reached on a HEADLESS box.
 *
 * A desktop login session exports this variable; an SSH session and anything
 * spawned from it (notably a detached AC2 daemon auto-started by an agent
 * host over SSH) does not. Without it `@napi-rs/keyring` cannot reach
 * `org.freedesktop.secrets` even though gnome-keyring is running under
 * `user@<uid>.service`, and it silently falls back to the volatile kernel
 * keyring — the exact failure {@link assertPersistentKeyStorage} then aborts
 * on, on a machine that actually HAS a working keychain.
 *
 * Only ever fills in a MISSING value, and only when the socket really exists,
 * so an explicitly configured bus (or a non-systemd setup) is never touched.
 *
 * @returns the address that was set, or `null` when the environment was left
 *   untouched.
 */
export function ensureSessionBusAddress(options: SessionBusOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return null;
  const env = options.env ?? process.env;
  if ((env['DBUS_SESSION_BUS_ADDRESS'] ?? '').trim().length > 0) return null;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) return null;
  const socketPath = `/run/user/${uid}/bus`;
  const exists = options.exists ?? existsSync;
  if (!exists(socketPath)) return null;
  const address = `unix:path=${socketPath}`;
  env['DBUS_SESSION_BUS_ADDRESS'] = address;
  return address;
}

/** Options for {@link assertPersistentKeyStorage}. */
export interface PersistenceProbeOptions {
  /** Platform override — test seam only (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** `/proc/keys` reader — test seam only. */
  readProcKeys?: () => string;
}

/**
 * Assert that `keyring` stores entries in a PERSISTENT credential store.
 *
 * On Linux, `@napi-rs/keyring` silently falls back to the kernel keyutils
 * facility when no Secret Service is reachable on the session bus (e.g.
 * gnome-keyring is not installed — common on headless servers). Kernel
 * keyrings are in-memory only: every entry is wiped on logout/reboot, so the
 * keystore's master key and all wallet-issued identity keys would silently
 * evaporate and every later start would fail with "master key is missing".
 *
 * The check writes a uniquely-named probe entry and looks for it in
 * `/proc/keys` (keyutils descriptions are `keyring:<service>@<account>`, so a
 * keyutils-backed probe is visible there; a Secret Service entry is not). The
 * probe is deleted either way. When `/proc/keys` cannot be read (unusual
 * container configs) the check is inconclusive and does not block.
 *
 * @throws When the keyring is backed by the volatile kernel keyring, or when
 *   the probe write itself fails hard (e.g. the Secret Service is locked).
 */
export function assertPersistentKeyStorage(
  keyring: KeyringBinding,
  options: PersistenceProbeOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return;
  const probeAccount = `ac2-keyring-probe-${randomBytes(4).toString('hex')}`;
  keyring.set(probeAccount, 'probe');
  try {
    let procKeys: string;
    try {
      procKeys = options.readProcKeys ? options.readProcKeys() : readFileSync('/proc/keys', 'utf8');
    } catch {
      // The kernel keyring is not inspectable here — inconclusive, don't block.
      return;
    }
    if (procKeys.includes(probeAccount)) {
      throw new Error(
        '[ac2] no persistent OS keychain is available: the keyring fell back to the ' +
          'kernel session keyring (keyutils), which is wiped on logout/reboot — refusing ' +
          'to store keys there. Install and unlock a Secret Service provider (e.g. ' +
          '`apt install gnome-keyring`) and restart the AC2 service. On a headless ' +
          'machine the keyring must also be unlocked without a desktop login — see ' +
          '"Headless keyring" in the AC2 troubleshooting guide.',
      );
    }
  } finally {
    try {
      keyring.delete(probeAccount);
    } catch {
      // Best-effort cleanup; the probe entry carries no secret.
    }
  }
}
