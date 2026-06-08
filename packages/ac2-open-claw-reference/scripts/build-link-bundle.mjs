#!/usr/bin/env node
/**
 * Build a self-contained, symlink-free `.link-bundle/` directory that
 * `openclaw plugins install --link` can accept.
 *
 * Why this exists:
 *   `openclaw plugins install --link .` runs a code-safety scan that rejects any
 *   `node_modules` entry that is a symlink/junction whose target resolves OUTSIDE
 *   the install root. In this pnpm + Windows workspace EVERY dependency in
 *   `node_modules` is a reparse point — the two first-party deps
 *   (`@algorandfoundation/ac2-sdk`, `@algorandfoundation/liquid-client`) are
 *   junctions to `../../packages/*`, and the rest are content-addressed links
 *   into the global pnpm store. `pnpm deploy` (even `--legacy`) only hardlinks,
 *   so its output is still full of store/workspace-escaping reparse points and
 *   the scan keeps failing.
 *
 * What this does:
 *   1. `pnpm deploy` the plugin's PROD dependency closure into a temp dir
 *      (resolves `workspace:*` to real versions, drops devDeps like `openclaw`).
 *   2. Dereference-copy that temp dir into `.link-bundle/` with
 *      `fs.cpSync(..., { dereference: true })`, which copies real file CONTENTS
 *      and therefore produces a tree with NO reparse points at all.
 *
 * The dev workspace (its junctions, `node_modules`, lockfile) is never mutated,
 * so tests/builds keep working. Install the bundle with:
 *   openclaw plugins install --link .link-bundle
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const PKG_NAME = '@ac2/ac2-open-claw-reference';
const BUNDLE_DIR = join(pkgRoot, '.link-bundle');

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(cmd, args, cwd) {
  console.log(`[link-bundle] $ ${cmd} ${args.join(' ')}`);
  // `shell: true` is required on Windows + Node >= 18 to spawn `.cmd` shims
  // (e.g. `pnpm.cmd`); without it spawnSync throws EINVAL.
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: true });
}

const deployTmp = mkdtempSync(join(tmpdir(), 'ac2-link-'));
try {
  // 1. Assemble the prod closure (links into the store / workspace).
  run(
    pnpm,
    ['--filter', PKG_NAME, 'deploy', '--prod', '--legacy', '--ignore-scripts', deployTmp],
    repoRoot,
  );

  // 2. Dereference-copy into a fully real, link-free bundle.
  if (existsSync(BUNDLE_DIR)) rmSync(BUNDLE_DIR, { recursive: true, force: true });
  cpSync(deployTmp, BUNDLE_DIR, { recursive: true, dereference: true, force: true });

  // 3. Restore generated native binaries that `pnpm deploy --ignore-scripts`
  //    drops. `node-datachannel` compiles its addon into `build/Release/` via a
  //    postinstall (prebuild-install) step at install time; that `build/` dir
  //    lives only in the real `node_modules` copy, never in the pnpm store, so
  //    the deployed/derefed tree is missing `node_datachannel.node` and the
  //    plugin crashes at load with "Cannot find module
  //    '../../../build/Release/node_datachannel.node'". Copy it back.
  for (const nativePkg of ['node-datachannel']) {
    const buildSrc = join(repoRoot, 'node_modules', nativePkg, 'build');
    const buildDst = join(BUNDLE_DIR, 'node_modules', nativePkg, 'build');
    if (existsSync(buildSrc) && existsSync(join(BUNDLE_DIR, 'node_modules', nativePkg))) {
      cpSync(buildSrc, buildDst, { recursive: true, dereference: true, force: true });
      console.log(`[link-bundle] restored native build/ for ${nativePkg}`);
    }
  }

  console.log(`[link-bundle] done — self-contained bundle at ${BUNDLE_DIR}`);
} finally {
  rmSync(deployTmp, { recursive: true, force: true });
}
