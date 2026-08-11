/**
 * Tests for the daemon↔launcher startup-failure handshake
 * (`src/daemon/startup-report.ts`): the structured report the daemon writes
 * when startup fails, which the launcher reads instead of parsing the log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearStartupFailure,
  readStartupFailure,
  reportStartupFailure,
  resolveStartupErrorFilePath,
} from '../src/daemon/startup-report.js';
import { AC2_DAEMON_VERSION } from '../src/daemon/version.js';

describe('startup-report', () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ac2-startup-report-'));
    env = { ...process.env, AC2_HOME: tmpDir };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a startup failure (write → read → clear)', async () => {
    const before = Date.now();
    await reportStartupFailure(new Error('keystore metadata is present but…'), env);

    const report = await readStartupFailure(env);
    expect(report).not.toBeNull();
    expect(report!.message).toBe('keystore metadata is present but…');
    expect(report!.pid).toBe(process.pid);
    expect(report!.version).toBe(AC2_DAEMON_VERSION);
    expect(Date.parse(report!.timestamp)).toBeGreaterThanOrEqual(before);

    await clearStartupFailure(env);
    expect(await readStartupFailure(env)).toBeNull();
  });

  it('stringifies non-Error failures', async () => {
    await reportStartupFailure('plain string reason', env);
    expect((await readStartupFailure(env))?.message).toBe('plain string reason');
  });

  it('writes the report file with owner-only permissions inside AC2_HOME', async () => {
    await reportStartupFailure(new Error('boom'), env);
    const path = resolveStartupErrorFilePath(env);
    expect(path.startsWith(tmpDir)).toBe(true);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    // The file must be valid, pretty-printed JSON (a human may cat it too).
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { message: string };
    expect(parsed.message).toBe('boom');
  });

  it('returns null when the report is missing', async () => {
    expect(await readStartupFailure(env)).toBeNull();
  });

  it('returns null for a malformed or incompatible report instead of throwing', async () => {
    const path = resolveStartupErrorFilePath(env);
    await writeFile(path, 'not json at all');
    expect(await readStartupFailure(env)).toBeNull();

    await writeFile(path, JSON.stringify({ message: 42, timestamp: 'nope' }));
    expect(await readStartupFailure(env)).toBeNull();

    await writeFile(path, JSON.stringify({ message: 'x', timestamp: 'not-a-date' }));
    expect(await readStartupFailure(env)).toBeNull();
  });

  it('clearStartupFailure is a no-op when nothing was reported', async () => {
    await expect(clearStartupFailure(env)).resolves.toBeUndefined();
  });
});
