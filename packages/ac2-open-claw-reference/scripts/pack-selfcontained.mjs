/**
 * Build a FULLY SELF-CONTAINED OpenClaw plugin tarball for the `ac2` plugin.
 *
 * Why this exists
 * ---------------
 * The plugin's runtime dependencies include packages that are NOT resolvable
 * from the public npm registry:
 *   - `@algorandfoundation/ac2-cli`  — never published (the plugin spawns its
 *     `ac2` bin to auto-start the daemon, so it must be a real installed
 *     package, not inlined),
 *   - `@algorandfoundation/ac2-sdk`  — the local build carries `./runtime` and
 *     `./providers/*` export subpaths that the published canary does not, so
 *     it must be the LOCAL build, never fetched,
 *   - `@algorandfoundation/keystore-node` / `keystore-core` — vendored tarballs
 *     (canary.16), unpublished.
 *
 * OpenClaw installs a plugin tarball by copying it to a staging dir (a shipped
 * `node_modules/` is PRESERVED verbatim) and then running
 *   `npm install --omit=dev --loglevel=error --ignore-scripts`
 * with `NPM_CONFIG_PACKAGE_LOCK=false NPM_CONFIG_SAVE=false
 * NPM_CONFIG_IGNORE_SCRIPTS=true`, honouring `bundledDependencies`. Because
 * `--ignore-scripts` is enforced, native postinstalls (notably `@roamhq/wrtc`,
 * which DOWNLOADS its prebuilt binary in a postinstall) never run on the host.
 *
 * The only reliable way to install with zero network AND working native deps
 * is therefore to ship a pre-built `node_modules` INSIDE the tarball and list
 * every top-level entry in `bundledDependencies`, so the host install is a
 * no-op (nothing to fetch, nothing to build).
 *
 * What this script does
 * ---------------------
 *  1. `npm pack` the local `ac2-sdk` and `ac2-cli` into vendor tarballs, and
 *     copy ac2-cli's vendored `keystore-node`/`keystore-core` tarballs.
 *  2. Assemble a staging dir: the plugin's built `dist/`, `openclaw.plugin.json`,
 *     `skills/`, `README.md`, `LICENSE`, and a rewritten `package.json` whose
 *     unpublished deps are `file:vendor/*.tgz` (with `keystore-node`/
 *     `keystore-core` promoted to top-level file: deps so nested requirements
 *     resolve by hoisting), and whose `openclaw` manifest block is preserved.
 *  3. Run a NORMAL `npm install` (scripts ENABLED) in the staging dir so the
 *     full tree — including the wrtc/keyring native binaries — is materialised.
 *     THIS step needs network; the produced tarball does not.
 *  4. Set `bundledDependencies` to every top-level package in the staging
 *     `node_modules`, then `npm pack` the staging dir.
 *
 * Requirements
 * ------------
 *  - Run AFTER `pnpm -r build` (this script packs the built `dist/` outputs and
 *    errors if they are missing).
 *  - Run with the `node`/`npm` whose ABI matches the TARGET gateway (the native
 *    binaries are baked into the tarball). For the local gateway that is the
 *    Node that runs `openclaw gateway`.
 *
 * Usage
 * -----
 *   node scripts/pack-selfcontained.mjs [--out <dir>] [--keep-stage]
 *
 * Prints the absolute path of the produced `.tgz` on stdout (last line).
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const packagesDir = resolve(pluginRoot, '..');
const cliRoot = resolve(packagesDir, 'ac2-cli');
const sdkRoot = resolve(packagesDir, 'ac2-sdk');
const cliVendorDir = resolve(cliRoot, 'vendor');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 ? resolve(argv[outIdx + 1]) : tmpdir();
const keepStage = argv.includes('--keep-stage');

/** Run a command, inheriting stdio for the noisy steps, and fail loudly. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed with exit code ${res.status ?? 'null'}`);
  }
  return res;
}

/** Run a command capturing stdout (trimmed), failing loudly on error. */
function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed with exit code ${res.status ?? 'null'}`);
  }
  return (res.stdout || '').trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** `npm pack <pkgDir>` into `destDir`; returns the absolute tarball path. */
function npmPackInto(pkgDir, destDir) {
  const out = runCapture('npm', ['pack', '--pack-destination', destDir, '--silent'], { cwd: pkgDir });
  const name = out.split(/\r?\n/).filter(Boolean).pop();
  if (!name) throw new Error(`npm pack produced no output for ${pkgDir}`);
  // --silent may print just the filename (relative to destDir) or an absolute path.
  return resolve(destDir, basename(name));
}

/**
 * `pnpm pack <pkgDir>` into `destDir`; returns the absolute tarball path.
 *
 * Used for the LOCAL workspace packages (`ac2-sdk`, `ac2-cli`) because they
 * declare intra-workspace deps with pnpm's `workspace:*` protocol. `npm pack`
 * leaves those specifiers verbatim (then a later `npm install` fails with
 * `EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`), whereas
 * `pnpm pack` rewrites them to the concrete published version.
 */
function pnpmPackInto(pkgDir, destDir) {
  const out = runCapture('pnpm', ['pack', '--pack-destination', destDir, '--silent'], { cwd: pkgDir });
  const name = out.split(/\r?\n/).filter(Boolean).pop();
  if (!name) throw new Error(`pnpm pack produced no output for ${pkgDir}`);
  return resolve(destDir, basename(name));
}

// ── 0. Sanity: everything must be built. ────────────────────────────────────
for (const [label, distEntry] of [
  ['plugin', join(pluginRoot, 'dist', 'entry.js')],
  ['ac2-cli', join(cliRoot, 'dist', 'cli.js')],
  ['ac2-sdk', join(sdkRoot, 'dist', 'index.js')],
]) {
  if (!existsSync(distEntry)) {
    throw new Error(
      `${label} is not built (missing ${distEntry}). Run \`pnpm -r build\` from the repo root first.`,
    );
  }
}

const pluginPkg = readJson(join(pluginRoot, 'package.json'));
const cliPkg = readJson(join(cliRoot, 'package.json'));
const sdkPkg = readJson(join(sdkRoot, 'package.json'));

const workRoot = mkdtempSync(join(tmpdir(), 'ac2-selfcontained-'));
const stageDir = join(workRoot, 'stage');
const stageVendor = join(stageDir, 'vendor');
mkdirSync(stageVendor, { recursive: true });

try {
  // ── 1. Vendor the unpublished packages as tarballs. ───────────────────────
  console.log('[selfcontained] packing local ac2-sdk and ac2-cli…');
  const sdkTgz = pnpmPackInto(sdkRoot, stageVendor);
  const cliTgz = pnpmPackInto(cliRoot, stageVendor);

  // ac2-cli's vendored keystore tarballs (unpublished; npm ignores the pnpm
  // workspace override that supplies keystore-core, so we vendor it too).
  const keystoreTarballs = readdirSync(cliVendorDir).filter((f) => f.endsWith('.tgz'));
  const findKs = (needle) => {
    const f = keystoreTarballs.find((n) => n.includes(needle));
    if (!f) throw new Error(`could not find ${needle} tarball in ${cliVendorDir}`);
    cpSync(join(cliVendorDir, f), join(stageVendor, f));
    return f;
  };
  const keystoreNodeTgz = findKs('keystore-node');
  const keystoreCoreTgz = findKs('keystore-core');

  // ── 2. Assemble the staging package contents. ─────────────────────────────
  console.log('[selfcontained] assembling staging package…');
  for (const entry of ['dist', 'openclaw.plugin.json', 'skills', 'README.md', 'LICENSE']) {
    const src = join(pluginRoot, entry);
    if (existsSync(src)) cpSync(src, join(stageDir, entry), { recursive: true });
  }

  // Build the staging package.json: keep the manifest + metadata, drop dev-only
  // fields, and rewrite the unpublished deps to file:vendor/*.tgz.
  const publishedRuntimeDeps = { ...(pluginPkg.dependencies ?? {}) };
  delete publishedRuntimeDeps['@algorandfoundation/ac2-cli'];
  delete publishedRuntimeDeps['@algorandfoundation/ac2-sdk'];

  const dependencies = {
    '@algorandfoundation/ac2-cli': `file:vendor/${basename(cliTgz)}`,
    '@algorandfoundation/ac2-sdk': `file:vendor/${basename(sdkTgz)}`,
    // Promote keystore packages to top-level file: deps so keystore-node's
    // requirement on keystore-core resolves by hoisting (npm does not honour
    // the pnpm workspace override).
    '@algorandfoundation/keystore-node': `file:vendor/${keystoreNodeTgz}`,
    '@algorandfoundation/keystore-core': `file:vendor/${keystoreCoreTgz}`,
    ...publishedRuntimeDeps,
    // Direct transitive deps listed so they survive the host's prune (a
    // bundledDependency should also appear in dependencies).
    ...(sdkPkg.dependencies?.ajv ? { ajv: sdkPkg.dependencies.ajv } : {}),
    ...(cliPkg.dependencies?.['@tanstack/store']
      ? { '@tanstack/store': cliPkg.dependencies['@tanstack/store'] }
      : {}),
  };

  // Optional (native / signalling) deps come from the SDK; keep them optional so
  // a missing optional canary never blocks the staging install.
  const optionalDependencies = { ...(sdkPkg.optionalDependencies ?? {}) };

  const stagePkg = {
    name: pluginPkg.name,
    version: pluginPkg.version,
    description: pluginPkg.description,
    license: pluginPkg.license,
    keywords: pluginPkg.keywords,
    type: pluginPkg.type,
    sideEffects: pluginPkg.sideEffects ?? false,
    main: pluginPkg.main,
    types: pluginPkg.types,
    exports: pluginPkg.exports,
    files: [...new Set([...(pluginPkg.files ?? []), 'vendor'])],
    // The OpenClaw manifest block is REQUIRED — losing it makes the install
    // fail with "package.json missing openclaw.extensions".
    openclaw: pluginPkg.openclaw,
    dependencies,
    optionalDependencies,
  };
  writeFileSync(join(stageDir, 'package.json'), JSON.stringify(stagePkg, null, 2) + '\n');

  // ── 3. Materialise the full tree WITH scripts (native binaries build here). ─
  console.log('[selfcontained] installing full dependency tree (scripts enabled, needs network)…');
  run('npm', ['install', '--omit=dev', '--no-package-lock', '--loglevel=error'], { cwd: stageDir });

  // ── 4. Bundle every top-level node_modules entry, then pack. ──────────────
  const nmDir = join(stageDir, 'node_modules');
  const bundled = [];
  for (const entry of readdirSync(nmDir)) {
    if (entry === '.bin' || entry === '.package-lock.json') continue;
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(join(nmDir, entry))) {
        bundled.push(`${entry}/${scoped}`);
      }
    } else {
      bundled.push(entry);
    }
  }
  stagePkg.bundledDependencies = bundled.sort();
  writeFileSync(join(stageDir, 'package.json'), JSON.stringify(stagePkg, null, 2) + '\n');

  console.log(`[selfcontained] bundling ${bundled.length} packages and packing…`);
  mkdirSync(outDir, { recursive: true });
  const tgz = npmPackInto(stageDir, outDir);

  console.log(`[selfcontained] wrote self-contained plugin tarball (bundled node_modules).`);
  // Final line: the tarball path (consumed by callers / install:selfcontained).
  process.stdout.write(tgz + '\n');
} finally {
  if (!keepStage) rmSync(workRoot, { recursive: true, force: true });
  else console.log(`[selfcontained] staging kept at ${workRoot}`);
}
