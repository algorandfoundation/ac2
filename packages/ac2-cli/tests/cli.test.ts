/**
 * Tests for the `ac2` CLI's argument parsing. The CLI itself is kept thin
 * (see `src/cli.ts`) and delegates command dispatch to `runDaemon`/the
 * control client/the daemon manager, so it is not re-tested by spawning a
 * process here — only the pure parsing logic is unit-tested.
 */

import { describe, it, expect } from 'vitest';
import { CliArgsError, parseCliArgs } from '../src/cli-args.js';

describe('parseCliArgs', () => {
  it('parses a bare command with no flags', () => {
    expect(parseCliArgs(['service', 'status'])).toEqual({
      command: ['service', 'status'],
      flags: {},
    });
  });

  it('parses boolean flags', () => {
    expect(parseCliArgs(['service', 'start', '--foreground', '--auto-pair'])).toEqual({
      command: ['service', 'start'],
      flags: { foreground: true, autoPair: true },
    });
  });

  it('parses string-valued flags regardless of position', () => {
    expect(
      parseCliArgs(['service', 'start', '--origin', 'https://example.test', '--agent', 'openclaw']),
    ).toEqual({
      command: ['service', 'start'],
      flags: { origin: 'https://example.test', agent: 'openclaw' },
    });
    expect(parseCliArgs(['--origin', 'https://example.test', 'service', 'start'])).toEqual({
      command: ['service', 'start'],
      flags: { origin: 'https://example.test' },
    });
  });

  it('parses numeric flags (-n/--lines, --timeout)', () => {
    expect(parseCliArgs(['service', 'logs', '-n', '10'])).toEqual({
      command: ['service', 'logs'],
      flags: { lines: 10 },
    });
    expect(parseCliArgs(['pair', '--timeout', '5000'])).toEqual({
      command: ['pair'],
      flags: { timeout: 5000 },
    });
  });

  it('parses --all and --id for forget', () => {
    expect(parseCliArgs(['forget', '--all'])).toEqual({
      command: ['forget'],
      flags: { all: true },
    });
    expect(parseCliArgs(['forget', '--id', 'req-123'])).toEqual({
      command: ['forget'],
      flags: { id: 'req-123' },
    });
  });

  it('parses -h/--help with no command', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: [], flags: { help: true } });
    expect(parseCliArgs(['-h'])).toEqual({ command: [], flags: { help: true } });
  });

  it('returns an empty command with no flags for an empty argv', () => {
    expect(parseCliArgs([])).toEqual({ command: [], flags: {} });
  });

  it('throws CliArgsError on an unknown flag', () => {
    expect(() => parseCliArgs(['service', 'start', '--bogus'])).toThrow(CliArgsError);
  });

  it('throws CliArgsError when a value-flag is missing its value', () => {
    expect(() => parseCliArgs(['service', 'start', '--origin'])).toThrow(CliArgsError);
  });
});
