/**
 * Tree-shakeable flat distribution builder for the AC2 OpenClaw plugin.
 *
 * Emits one ESM JS file per source file under `dist/`, using a flattened
 * naming scheme so every file lives at the top of `dist/` with no nested
 * directories:
 *
 *     src/entry.ts                  -> dist/entry.js
 *     src/channel/routing.ts        -> dist/channel.routing.js
 *     src/keystore/storage/state.ts -> dist/keystore.storage.state.js
 *
 * No dependencies are vendored. Every non-relative import (third-party
 * packages, Node built-ins, host SDKs, native add-ons) is kept external, so
 * the host installs them via the normal package manager and the bundle
 * stays tree-shakeable.
 *
 * Relative imports inside the emitted JS (and the matching `.d.ts` files
 * produced by `tsc`) are rewritten to the flattened sibling names.
 */

import { transform } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import {
  rmSync,
  rmdirSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
} from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const srcDir = resolve(pkgRoot, 'src');
const distDir = resolve(pkgRoot, 'dist');

const FLATTEN_DTS_ONLY = process.argv.includes('--flatten-dts');

if (!FLATTEN_DTS_ONLY) {
  // Wipe and recreate dist/ so no stale nested artifacts survive next to the
  // flat output.
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
}

/** Recursively list files under `dir` matching `predicate`. */
function walk(dir, predicate) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full, predicate));
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Map a source file (absolute path under `src/`) to its flattened dist
 * basename (without extension). `src/channel/routing.ts` -> `channel.routing`.
 */
function flatName(srcAbsPath, sourceRoot = srcDir) {
  const rel = relative(sourceRoot, srcAbsPath).replace(/\\/g, '/');
  const noExt = rel.replace(/\.[mc]?tsx?$/i, '').replace(/\.d$/i, '');
  return noExt.split('/').join('.');
}

/**
 * Rewrite a relative import specifier (e.g. `./session/manager.js`) emitted
 * from `srcFile` so it points at the flattened sibling in `dist/`.
 *
 * Non-relative specifiers (bare packages, `node:` built-ins) are returned
 * as-is so they stay external.
 */
function rewriteSpecifier(specifier, srcFile, sourceRoot = srcDir) {
  if (!specifier.startsWith('.')) return specifier;

  // Drop trailing extension; we'll re-add `.js`.
  const cleaned = specifier.replace(/\.(m?js|d\.ts|ts|tsx)$/i, '');

  // Resolve the target relative to the source file's directory, then express
  // it relative to `sourceRoot` to derive the flat name.
  const targetAbs = resolve(dirname(srcFile), cleaned);
  const relFromRoot = relative(sourceRoot, targetAbs).replace(/\\/g, '/');

  // Imports that escape `src/` (shouldn't happen for valid plugin code) are
  // left as-is so the error surfaces at runtime/type-check time.
  if (relFromRoot.startsWith('..')) return specifier;

  return './' + relFromRoot.split('/').join('.') + '.js';
}

/** Regex covering ESM static/dynamic import + re-export specifier forms. */
const SPECIFIER_RE =
  /((?:^|[^.\w$])(?:import|export)\s*(?:[\s\S]*?)\s*from\s*|(?:^|[^.\w$])import\s*\(\s*|(?:^|[^.\w$])export\s*\*\s*from\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;

function rewriteRelativeImports(source, srcFile, sourceRoot = srcDir) {
  return source.replace(SPECIFIER_RE, (_match, lead, quote, spec) => {
    const next = rewriteSpecifier(spec, srcFile, sourceRoot);
    return `${lead}${quote}${next}${quote}`;
  });
}

// ── Pass 1: transpile each .ts to a flattened .js next to its siblings. ──
const sources = FLATTEN_DTS_ONLY
  ? []
  : walk(srcDir, (f) => /\.(m?ts|tsx)$/i.test(f) && !/\.d\.ts$/i.test(f));
for (const srcFile of sources) {
  const code = readFileSync(srcFile, 'utf8');
  const { code: jsCode, map } = await transform(code, {
    loader: srcFile.endsWith('.tsx') ? 'tsx' : 'ts',
    format: 'esm',
    target: 'node22',
    platform: 'node',
    sourcefile: relative(pkgRoot, srcFile),
    sourcemap: 'external',
  });

  const rewritten = rewriteRelativeImports(jsCode, srcFile);
  const outBase = flatName(srcFile);
  const outJs = join(distDir, `${outBase}.js`);
  const outMap = `${outJs}.map`;

  writeFileSync(outJs, `${rewritten}\n//# sourceMappingURL=${outBase}.js.map\n`);
  writeFileSync(outMap, map);
}

// ── Pass 2: flatten the declaration files emitted separately by `tsc`. ──
//
// `tsc -p tsconfig.build.json` writes nested `.d.ts` files (e.g.
// `dist/channel/routing.d.ts`). This pass renames them to the flat scheme
// and rewrites their relative imports so types still resolve next to the JS.
function flattenDeclarations() {
  const dtsFiles = walk(distDir, (f) => f.endsWith('.d.ts'));
  if (dtsFiles.length === 0) return;

  // Compute the original `dist` source root for d.ts (mirrors `src/`).
  // For each nested d.ts, derive flat name as if it lived under `src/`.
  for (const dts of dtsFiles) {
    const rel = relative(distDir, dts).replace(/\\/g, '/');
    if (!rel.includes('/')) continue; // already flat (e.g. dist/entry.d.ts)

    const base = rel.replace(/\.d\.ts$/i, '');
    const flat = base.split('/').join('.') + '.d.ts';
    const flatPath = join(distDir, flat);

    const body = readFileSync(dts, 'utf8');
    // Treat d.ts file as if it lived under src/, rewriting its specifiers.
    const fakeSrc = join(srcDir, base + '.ts');
    let rewritten = rewriteRelativeImports(body, fakeSrc);
    // Re-point the `//# sourceMappingURL=...` trailer at the renamed map.
    rewritten = rewritten.replace(
      /\/\/#\s*sourceMappingURL=.*$/m,
      `//# sourceMappingURL=${flat}.map`,
    );
    writeFileSync(flatPath, rewritten);
    unlinkSync(dts);

    // Rename associated declaration map if present.
    const dtsMap = `${dts}.map`;
    if (existsSync(dtsMap)) {
      renameSync(dtsMap, `${flatPath}.map`);
    }
  }

  // Rewrite already-flat d.ts files (top-level ones like entry.d.ts) too.
  for (const dts of walk(distDir, (f) => f.endsWith('.d.ts'))) {
    const rel = relative(distDir, dts).replace(/\\/g, '/');
    if (rel.includes('/')) continue;
    const base = rel.replace(/\.d\.ts$/i, '');
    const fakeSrc = join(srcDir, base.split('.').join('/') + '.ts');
    const body = readFileSync(dts, 'utf8');
    const rewritten = rewriteRelativeImports(body, fakeSrc);
    if (rewritten !== body) writeFileSync(dts, rewritten);
  }

  // Best-effort: prune now-empty nested directories.
  function pruneEmpty(dir) {
    if (dir === distDir) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) pruneEmpty(full);
    }
    if (readdirSync(dir).length === 0) {
      rmdirSync(dir);
    }
  }
  for (const e of readdirSync(distDir)) {
    const full = join(distDir, e);
    if (statSync(full).isDirectory()) pruneEmpty(full);
  }
}

// `tsc` runs after this script in the `build` npm script. Expose the
// declaration flattener as a CLI entry so it can be invoked after `tsc`.
if (process.argv.includes('--flatten-dts')) {
  flattenDeclarations();
  // eslint-disable-next-line no-console
  console.log('[bundle] dist/*.d.ts flattened.');
} else {
  // eslint-disable-next-line no-console
  console.log(
    `[bundle] wrote ${sources.length} flat ESM file(s) to dist/ (all dependencies external).`,
  );
}
