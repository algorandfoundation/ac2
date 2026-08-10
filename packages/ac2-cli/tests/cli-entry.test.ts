/**
 * Tests for the `ac2` entry-point guard (`src/cli-entry.ts`).
 *
 * The unit cases inject `argv1`, the platform and a fake `realpath`, so the
 * Windows and Linux launcher shapes are covered on any host. The final case is
 * a real `node` run through a bin *symlink* — the npm/pnpm install layout that
 * used to make the CLI exit silently.
 */

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { transformSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDirectInvocation, moduleUrlToPath } from '../src/cli-entry.js';

/** A `realpath` that follows one fake symlink table and passes through misses. */
const fakeRealpath =
  (links: Record<string, string>) =>
  (path: string): string =>
    links[path] ?? path;

describe('moduleUrlToPath', () => {
  it('converts POSIX file URLs, decoding percent escapes', () => {
    expect(moduleUrlToPath('file:///opt/ac2/dist/cli.js')).toBe('/opt/ac2/dist/cli.js');
    expect(moduleUrlToPath('file:///opt/my%20apps/cli.js')).toBe('/opt/my apps/cli.js');
  });

  it('converts Windows file URLs by dropping the leading slash', () => {
    expect(moduleUrlToPath('file:///C:/Users/me/node_modules/.pnpm/cli.js')).toBe(
      'C:/Users/me/node_modules/.pnpm/cli.js',
    );
  });

  it('passes plain paths through untouched', () => {
    expect(moduleUrlToPath('/opt/ac2/dist/cli.js')).toBe('/opt/ac2/dist/cli.js');
  });
});

describe('isDirectInvocation', () => {
  const dist = '/opt/app/node_modules/@algorandfoundation/ac2-cli/dist/cli.js';
  const selfUrl = `file://${dist}`;

  it('accepts the plain `node dist/cli.js` invocation', () => {
    expect(isDirectInvocation(selfUrl, { argv1: dist, platform: 'linux', realpath: (p) => p })).toBe(
      true,
    );
  });

  it('accepts the npm/pnpm bin symlink (the install-layout regression)', () => {
    const bin = '/opt/app/node_modules/.bin/ac2';
    expect(
      isDirectInvocation(selfUrl, {
        argv1: bin,
        platform: 'linux',
        realpath: fakeRealpath({ [bin]: dist }),
      }),
    ).toBe(true);
  });

  it('accepts a Windows shim path regardless of separators and casing', () => {
    const winSelf = 'file:///C:/Users/Me/AppData/npm/node_modules/ac2-cli/dist/cli.js';
    const winEntry = 'C:\\Users\\me\\AppData\\npm\\node_modules\\ac2-cli\\dist\\CLI.js';
    expect(
      isDirectInvocation(winSelf, { argv1: winEntry, platform: 'win32', realpath: (p) => p }),
    ).toBe(true);
  });

  it('accepts paths with spaces and non-ASCII characters (percent-encoded URL)', () => {
    const path = '/Users/josé/my apps/ac2-cli/dist/cli.js';
    const url = `file:///Users/jos%C3%A9/my%20apps/ac2-cli/dist/cli.js`;
    expect(isDirectInvocation(url, { argv1: path, platform: 'darwin', realpath: (p) => p })).toBe(
      true,
    );
  });

  it('accepts a wrapper named after the bin even when it resolves elsewhere', () => {
    expect(
      isDirectInvocation(selfUrl, {
        argv1: '/opt/app/.yarn/unplugged/shims/ac2',
        platform: 'linux',
        realpath: (p) => p,
      }),
    ).toBe(true);
    expect(
      isDirectInvocation(selfUrl, {
        argv1: 'C:\\opt\\app\\node_modules\\.bin\\AC2.CMD',
        platform: 'win32',
        realpath: (p) => p,
      }),
    ).toBe(true);
  });

  it('rejects being imported by an unrelated entry point', () => {
    expect(
      isDirectInvocation(selfUrl, {
        argv1: '/opt/app/node_modules/.bin/openclaw',
        platform: 'linux',
        realpath: (p) => p,
      }),
    ).toBe(false);
  });

  it('rejects a missing argv[1] (e.g. `node --eval`)', () => {
    expect(isDirectInvocation(selfUrl, { argv1: undefined, platform: 'linux' })).toBe(false);
    expect(isDirectInvocation(selfUrl, { argv1: '  ', platform: 'linux' })).toBe(false);
  });
});

describe('isDirectInvocation (real node run through a bin symlink)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ac2-cli-entry-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs `launcher` with real `node` and returns its stdout. */
  const runNode = (launcher: string): string => {
    const run = spawnSync(process.execPath, [launcher], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    return run.stdout.trim();
  };

  it('reports true for the real file and for the npm-style bin symlink', () => {
    // The guard runs in a plain node child (no TS loader), so it is transpiled
    // next to a stand-in for `dist/cli.js` — same layout, same symlinked bin.
    const source = new URL('../src/cli-entry.ts', import.meta.url);
    const guard = transformSync(readFileSync(source, 'utf8'), { loader: 'ts', format: 'esm' }).code;
    writeFileSync(join(dir, 'cli-entry.mjs'), guard);

    const entry = join(dir, 'cli.mjs');
    writeFileSync(
      entry,
      `import { isDirectInvocation } from './cli-entry.mjs';\n` +
        `console.log(isDirectInvocation(import.meta.url) ? 'direct' : 'imported');\n`,
    );
    const bin = join(dir, 'ac2');
    symlinkSync(entry, bin);

    expect(runNode(entry)).toBe('direct');
    expect(runNode(bin)).toBe('direct');
  });

  it('reports false when an unrelated entry point imports the module', () => {
    const source = new URL('../src/cli-entry.ts', import.meta.url);
    writeFileSync(
      join(dir, 'cli-entry.mjs'),
      transformSync(readFileSync(source, 'utf8'), { loader: 'ts', format: 'esm' }).code,
    );
    writeFileSync(
      join(dir, 'cli.mjs'),
      `import { isDirectInvocation } from './cli-entry.mjs';\n` +
        `export const verdict = isDirectInvocation(import.meta.url) ? 'direct' : 'imported';\n`,
    );
    const host = join(dir, 'host.mjs');
    writeFileSync(host, `import { verdict } from './cli.mjs';\nconsole.log(verdict);\n`);

    expect(runNode(host)).toBe('imported');
  });
});
