/**
 * Pack the plugin into a tarball with `devDependencies` stripped from its
 * package.json so the host's `npm install` only resolves runtime deps.
 *
 * Why: `openclaw plugins install <tgz>` extracts the tarball and runs
 * `npm install` inside the extraction. npm installs both `dependencies` and
 * `devDependencies` by default, and our workspace-only devDeps (e.g.
 * `@algorandfoundation/package-releaser`, `openclaw` itself) are not
 * published to the public registry, so the install 404s.
 *
 * Strategy:
 *   1. Snapshot `package.json` and rewrite it in place, removing
 *      `devDependencies` and `scripts` that only make sense in-workspace
 *      (the `prepare` lifecycle script which would re-run `tsc` on
 *      install, plus the `release` / `install:plugin` family).
 *   2. Run `pnpm pack --pack-destination <dir>` to produce the tarball.
 *   3. Restore the original `package.json` (always, even on failure).
 *
 * Prints the absolute path of the produced `.tgz` to stdout on success.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const pkgJsonPath = resolve(pkgRoot, 'package.json');

const destArgIdx = process.argv.indexOf('--pack-destination');
const dest = destArgIdx >= 0 ? process.argv[destArgIdx + 1] : '/tmp';

const original = readFileSync(pkgJsonPath, 'utf8');
const pkg = JSON.parse(original);

// Build the consumer-facing package.json: drop dev-only fields.
const stripped = { ...pkg };
delete stripped.devDependencies;

const SCRIPTS_TO_DROP = new Set([
  'prepare', // would re-run tsc/esbuild on `npm install` inside the host
  'build',
  'build:js',
  'build:types',
  'type-check',
  'test',
  'test:watch',
  'release',
  'release:dry-run',
  'dist:pack',
  'rebuild:node-datachannel',
  'install:plugin',
  'uninstall:plugin',
  'dev:natives',
  'dev:link',
  'dev:relink',
  'dev:unlink',
]);
if (stripped.scripts) {
  stripped.scripts = Object.fromEntries(
    Object.entries(stripped.scripts).filter(([k]) => !SCRIPTS_TO_DROP.has(k)),
  );
  if (Object.keys(stripped.scripts).length === 0) delete stripped.scripts;
}

writeFileSync(pkgJsonPath, JSON.stringify(stripped, null, 2) + '\n');

let exitCode = 0;
let tgzPath = '';
try {
  const result = spawnSync(
    'pnpm',
    ['pack', '--pack-destination', dest, '--silent'],
    { cwd: pkgRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    process.stdout.write(result.stdout || '');
    exitCode = result.status ?? 1;
  } else {
    // pnpm pack --silent prints just the tarball path on stdout.
    tgzPath = (result.stdout || '').trim().split(/\r?\n/).pop() ?? '';
    if (!tgzPath) {
      // Fallback: derive from name + version.
      const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
      tgzPath = resolve(dest, `${safeName}-${pkg.version}.tgz`);
    }
  }
} finally {
  writeFileSync(pkgJsonPath, original);
}

if (exitCode !== 0) process.exit(exitCode);
process.stdout.write(tgzPath + '\n');
