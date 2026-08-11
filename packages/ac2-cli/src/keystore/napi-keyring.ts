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
      entry(account).setPassword(secret);
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
