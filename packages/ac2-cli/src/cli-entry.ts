/**
 * "Was this process started *as* the `ac2` command?" — the guard `src/cli.ts`
 * uses before it dispatches a command.
 *
 * The naive check (`import.meta.url === \`file://${process.argv[1]}\``) is
 * wrong on every real installation:
 *
 * - **npm / npx / pnpm on Linux and macOS** put a *symlink* on `PATH`
 *   (`node_modules/.bin/ac2` -> `…/ac2-cli/dist/cli.js`). Node reports the
 *   symlink in `process.argv[1]` but resolves `import.meta.url` to the real
 *   file, so the two never match and the CLI exits silently (exit code 0, no
 *   output) — which is exactly what "installing the distribution shows no CLI
 *   commands" looks like.
 * - **Windows** paths (`C:\…\cli.js`) are not valid `file://` URLs at all, and
 *   the shims npm writes (`ac2.cmd`, `ac2.ps1`) invoke a path with backslashes
 *   and arbitrary casing.
 * - Any path with a space or a non-ASCII character breaks the string compare
 *   too, because a real file URL is percent-encoded.
 *
 * So the entry is compared as a *path*: both sides are resolved through
 * `realpath` (following the bin symlink), normalised for separator style, and
 * compared case-insensitively on Windows. Wrappers that neither symlink nor
 * exec the real file (Yarn PnP shims, for instance) are still recognised via
 * the launcher's file name.
 */

import { realpathSync } from 'node:fs';

/** Launcher file names that unambiguously mean "the `ac2` CLI was invoked". */
const BIN_NAMES = ['ac2'] as const;

/** Executable suffixes the OS package managers add to their shims. */
const SHIM_EXTENSIONS = ['.cmd', '.ps1', '.bat', '.exe', '.js', '.mjs', '.cjs'] as const;

/** Options for {@link isDirectInvocation} (all injectable for tests). */
export interface DirectInvocationOptions {
  /** The launcher path, i.e. `process.argv[1]`. */
  argv1?: string | undefined;
  /** Defaults to `process.platform`; only `'win32'` changes the comparison. */
  platform?: NodeJS.Platform;
  /** Symlink resolver; defaults to `realpathSync` (missing paths pass through). */
  realpath?: (path: string) => string;
}

/**
 * Convert a `file:` URL to a filesystem path, tolerating Windows drive paths.
 *
 * `node:url`'s `fileURLToPath` throws on a Windows URL when it runs on POSIX
 * (and vice versa), which would make the guard platform-dependent; this
 * conversion is deliberately platform-agnostic. Non-`file:` inputs are
 * returned untouched so a plain path can be passed in.
 */
export function moduleUrlToPath(moduleUrl: string): string {
  if (!moduleUrl.startsWith('file:')) return moduleUrl;
  const withoutScheme = moduleUrl.replace(/^file:(\/\/)?/, '');
  let path: string;
  try {
    path = decodeURIComponent(withoutScheme);
  } catch {
    path = withoutScheme;
  }
  // `file:///C:/dir/cli.js` -> `C:/dir/cli.js`
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

/** Separator-, trailing-slash- and (on Windows) case-insensitive path form. */
function normalizePath(path: string, platform: NodeJS.Platform): string {
  const unified = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? unified.toLowerCase() : unified;
}

/** Last segment of `path`, with any shim extension stripped. */
function launcherName(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const lower = name.toLowerCase();
  const extension = SHIM_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  return (extension ? lower.slice(0, -extension.length) : lower).trim();
}

/**
 * Whether the module identified by `moduleUrl` is the program Node was asked
 * to run (as opposed to a module some other entry point imported).
 */
export function isDirectInvocation(
  moduleUrl: string,
  options: DirectInvocationOptions = {},
): boolean {
  const argv1 = options.argv1 ?? process.argv[1];
  if (argv1 === undefined || argv1.trim() === '') return false;
  const platform = options.platform ?? process.platform;
  const realpath =
    options.realpath ??
    ((path: string): string => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    });

  const self = normalizePath(realpath(moduleUrlToPath(moduleUrl)), platform);
  const entry = normalizePath(realpath(argv1), platform);
  if (self === entry) return true;

  // A wrapper that neither symlinks nor execs the real file (e.g. a Yarn PnP
  // shim) still names itself after the bin it stands for.
  return BIN_NAMES.includes(launcherName(argv1) as (typeof BIN_NAMES)[number]);
}
