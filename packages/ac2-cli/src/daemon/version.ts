/**
 * The daemon's own package version, reported in `daemon.status` and used to
 * detect a *stale* daemon (one that was auto-started from an older install and
 * is still running after the package was upgraded — see
 * {@link ensureDaemonRunning}).
 *
 * Kept in its own tiny module (rather than in `daemon/run.ts`) so the
 * version-mismatch check in `control/agent.ts` can import it WITHOUT pulling
 * the whole daemon runtime (broker, keystore, SDK) into an agent host's cold
 * start path.
 *
 * The value is read from this package's own `package.json` at load time so it
 * always tracks the published release instead of a hand-maintained constant
 * that silently drifts out of date. A build/layout where `package.json` cannot
 * be resolved falls back to {@link FALLBACK_DAEMON_VERSION}.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Last resort when `package.json` cannot be located (e.g. an exotic bundler
 * that inlines/renames files). `0.0.0-unknown` sorts below every real release
 * and is obviously a fallback in `daemon.status`.
 */
export const FALLBACK_DAEMON_VERSION = '0.0.0-unknown';

/**
 * Walk up from this module looking for the package's own `package.json`.
 *
 * `scripts/bundle.mjs` flattens `src/daemon/version.ts` to `dist/daemon.version.js`
 * (so `package.json` is one level up, at the package root), while the source
 * and unflattened-`tsc` layouts nest it deeper. Rather than assume a depth,
 * every plausible parent is probed and the first `package.json` whose `name`
 * matches this package wins.
 */
function resolveOwnVersion(moduleUrl: string = import.meta.url): string {
  try {
    let dir = dirname(fileURLToPath(moduleUrl));
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === '@algorandfoundation/ac2-cli' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to the fallback below.
  }
  return FALLBACK_DAEMON_VERSION;
}

/** The daemon's own protocol/package version, reported in `daemon.status`. */
export const AC2_DAEMON_VERSION = resolveOwnVersion();
