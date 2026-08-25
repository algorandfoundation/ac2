import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AC2_CHANNEL_ENV_VARS,
  readChannelStatus,
  cmdSetup,
  resolveOpenClawConfigPath,
} from '../src/setup/config.js';
import { setupEntry } from '../src/setup/index.js';
import { buildChannelObject } from '../src/index.js';

/**
 * Item #5 (WIP.md): setup entry + manifest hygiene. These cover the
 * transport-free setup surface — `channelEnvVars`, the config-derived
 * status reader, the idempotent `setup`, and the setup-entry shape — none
 * of which should require booting the channel runtime.
 */
describe('setup entry + channel env vars (OpenClaw setup-entry contract)', () => {
  let prevStateDir: string | undefined;
  let prevConfigPath: string | undefined;
  let prevOpenClawHome: string | undefined;
  let prevServer: string | undefined;
  let dir: string;

  beforeEach(() => {
    prevStateDir = process.env['OPENCLAW_STATE_DIR'];
    prevConfigPath = process.env['OPENCLAW_CONFIG_PATH'];
    prevOpenClawHome = process.env['OPENCLAW_HOME'];
    prevServer = process.env['AC2_LIQUID_AUTH_SERVER'];
    dir = mkdtempSync(join(tmpdir(), 'ac2-setup-'));
    process.env['OPENCLAW_STATE_DIR'] = dir;
    delete process.env['OPENCLAW_CONFIG_PATH'];
    delete process.env['OPENCLAW_HOME'];
    delete process.env['AC2_LIQUID_AUTH_SERVER'];
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env['OPENCLAW_STATE_DIR'];
    else process.env['OPENCLAW_STATE_DIR'] = prevStateDir;
    if (prevConfigPath === undefined) delete process.env['OPENCLAW_CONFIG_PATH'];
    else process.env['OPENCLAW_CONFIG_PATH'] = prevConfigPath;
    if (prevOpenClawHome === undefined) delete process.env['OPENCLAW_HOME'];
    else process.env['OPENCLAW_HOME'] = prevOpenClawHome;
    if (prevServer === undefined) delete process.env['AC2_LIQUID_AUTH_SERVER'];
    else process.env['AC2_LIQUID_AUTH_SERVER'] = prevServer;
    rmSync(dir, { recursive: true, force: true });
  });

  it('declares AC2_LIQUID_AUTH_SERVER as a non-required channel env var', () => {
    const v = AC2_CHANNEL_ENV_VARS.find((e) => e.name === 'AC2_LIQUID_AUTH_SERVER');
    expect(v).toBeDefined();
    expect(v?.required).toBe(false);
    expect(typeof v?.description).toBe('string');
  });

  it('exposes channelEnvVars on the registered channel object', () => {
    const channel = buildChannelObject() as {
      channelEnvVars?: ReadonlyArray<{ name: string }>;
    };
    expect(channel.channelEnvVars?.some((e) => e.name === 'AC2_LIQUID_AUTH_SERVER')).toBe(true);
  });

  it('setup entry exposes status / setup / channelEnvVars without runtime', () => {
    const entry = setupEntry as {
      id?: string;
      channels?: string[];
      channelEnvVars?: ReadonlyArray<{ name: string }>;
      status?: () => unknown;
      setup?: () => string;
    };
    expect(entry.id).toBe('ac2');
    expect(entry.channels).toContain('ac2');
    expect(entry.channelEnvVars?.length).toBeGreaterThan(0);
    expect(typeof entry.status).toBe('function');
    expect(typeof entry.setup).toBe('function');
  });

  it('reports not-ready status for an empty/absent config', () => {
    const status = readChannelStatus();
    expect(status.channel).toBe('ac2');
    expect(status.pluginAllowed).toBe(false);
    expect(status.pluginEnabled).toBe(false);
    expect(status.bound).toBe(false);
    expect(status.ready).toBe(false);
    // No env, no config → default server.
    expect(status.liquidAuthServerSource).toBe('default');
  });

  it('prefers the AC2_LIQUID_AUTH_SERVER env override in status', () => {
    process.env['AC2_LIQUID_AUTH_SERVER'] = 'https://example.test';
    const status = readChannelStatus();
    expect(status.liquidAuthServer).toBe('https://example.test');
    expect(status.liquidAuthServerSource).toBe('env');
  });

  it('uses OPENCLAW_HOME when no explicit state/config path is set', () => {
    delete process.env['OPENCLAW_STATE_DIR'];
    delete process.env['OPENCLAW_CONFIG_PATH'];
    process.env['OPENCLAW_HOME'] = dir;
    expect(resolveOpenClawConfigPath()).toBe(join(dir, 'openclaw.json'));
  });

  it('cmdSetup makes the channel ready and is idempotent', () => {
    const first = cmdSetup();
    expect(first).toContain('config change(s) written');

    const after = readChannelStatus();
    expect(after.pluginAllowed).toBe(true);
    expect(after.pluginEnabled).toBe(true);
    expect(after.bound).toBe(true);
    expect(after.ready).toBe(true);
    expect(after.liquidAuthServerSource).toBe('config');

    const second = cmdSetup();
    expect(second).toContain('no changes needed');
  });

  it('reads liquidAuthServer from an existing config', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'openclaw.json'),
      JSON.stringify({ channels: { ac2: { liquidAuthServer: 'https://from-config.test' } } }),
    );
    const status = readChannelStatus();
    expect(status.liquidAuthServer).toBe('https://from-config.test');
    expect(status.liquidAuthServerSource).toBe('config');
  });
});
