/**
 * Self-contained distribution bundle builder for the AC2 OpenClaw plugin.
 *
 * Produces ESM bundles under `dist/` with every pure-JS dependency inlined, so
 * OpenClaw can load the plugin without the package's own `node_modules`. Only
 * the host SDK (`openclaw`), Node built-ins, and native add-ons (which ship
 * their own `.node` binaries and must be resolved from the host) are kept
 * external.
 *
 * Code splitting is enabled so module-level singletons (e.g. the shared
 * `SessionManager`) live in a single shared chunk imported by every entry,
 * preserving the cross-entry shared state that the tools <-> channel wiring
 * relies on.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const r = (p) => resolve(pkgRoot, p);

// Start from a clean dist/ so no stale per-module artifacts survive alongside
// the self-contained bundle. Declarations (`tsc --emitDeclarationOnly`) are
// written afterwards by the `build` npm script.
rmSync(r('dist'), { recursive: true, force: true });

/**
 * Kept external (NOT inlined into the bundle):
 * - `openclaw` / its plugin SDK: provided by the host runtime.
 * - Native add-ons: ship platform-specific `.node` binaries that cannot be
 *   inlined into JS; the host must have them installed.
 */
const externalPackages = ['openclaw', 'node-datachannel', '@napi-rs/keyring', '@roamhq/wrtc'];

// Match both the bare package and any subpath import (e.g. `openclaw/plugin-sdk/...`).
const external = externalPackages.flatMap((name) => [name, `${name}/*`]);

const common = {
  outdir: r('dist'),
  outbase: r('src'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  chunkNames: 'chunks/[name]-[hash]',
  legalComments: 'none',
  external,
  logLevel: 'info',
  // Some bundled (CJS) dependencies call `require(...)` for Node built-ins at
  // runtime. In an ESM output `require` is undefined, so esbuild's shim throws
  // "Dynamic require of ... is not supported". Re-create a real `require` from
  // the module URL so those calls resolve against the host's Node runtime.
  banner: {
    js: "import { createRequire as __ac2CreateRequire } from 'node:module'; const require = __ac2CreateRequire(import.meta.url);",
  },
};

// Pass 1 — OpenClaw runtime entries.
//
// These are the physical files OpenClaw's bundled-entry loader resolves at
// runtime. `entry.ts` captures `import.meta.url` to lazily resolve its channel
// sidecar (`./channel/plugin.js`), so its module body MUST stay in its own
// output file. Splitting is enabled so the shared module-level singletons
// (notably the `SessionManager` used by both the tools in `entry` and the
// channel plugin) resolve to ONE shared chunk — keeping the tools <-> channel
// state in sync.
//
// `index.ts` is intentionally excluded here: it re-exports `entry.ts`, which
// would make esbuild hoist `entry.ts` (and its `import.meta.url`) into a shared
// chunk and break sidecar resolution. It is built standalone in pass 2.
await build({
  ...common,
  splitting: true,
  entryPoints: {
    entry: r('src/entry.ts'), // openclaw.extensions
    'channel/plugin': r('src/channel/plugin.ts'), // channel-entry sidecar (`./channel/plugin.js`)
  },
});

// Pass 2 — package `main` for embedded consumers/tests.
//
// Self-contained (no splitting): `index.js` re-exports the plugin entry, whose
// `import.meta.url` then points at `dist/index.js`, so its `./channel/plugin.js`
// sidecar resolves to the real `dist/channel/plugin.js` produced in pass 1.
await build({
  ...common,
  splitting: false,
  entryPoints: { index: r('src/index.ts') },
});

// eslint-disable-next-line no-console
console.log('[bundle] dist/ written as a self-contained distribution bundle.');
