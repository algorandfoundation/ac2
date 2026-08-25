import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resolveConfig, type OpenClawApi } from '../src/runtime.js';

/**
 * `resolveConfig` must surface the `liquidAuthServer` documented on the
 * `channels.ac2` config surface (the one `ac2 setup` writes and `ac2 status`
 * reads) and honour the `AC2_LIQUID_AUTH_SERVER` env override at runtime —
 * otherwise pairing silently ignores the configured URL and falls back to the
 * default server.
 */
describe('resolveConfig — liquidAuthServer resolution', () => {
  let prevServer: string | undefined;

  beforeEach(() => {
    prevServer = process.env['AC2_LIQUID_AUTH_SERVER'];
    delete process.env['AC2_LIQUID_AUTH_SERVER'];
  });

  afterEach(() => {
    if (prevServer === undefined) delete process.env['AC2_LIQUID_AUTH_SERVER'];
    else process.env['AC2_LIQUID_AUTH_SERVER'] = prevServer;
  });

  it('reads liquidAuthServer from channels.ac2 config', () => {
    const api = {
      config: { channels: { ac2: { liquidAuthServer: 'https://from-channel.test' } } },
    } as unknown as OpenClawApi;
    expect(resolveConfig(api).liquidAuthServer).toBe('https://from-channel.test');
  });

  it('lets plugins.entries.ac2.config override the channel value', () => {
    const api = {
      config: {
        channels: { ac2: { liquidAuthServer: 'https://from-channel.test' } },
        plugins: { entries: { ac2: { config: { liquidAuthServer: 'https://from-entry.test' } } } },
      },
    } as unknown as OpenClawApi;
    expect(resolveConfig(api).liquidAuthServer).toBe('https://from-entry.test');
  });

  it('AC2_LIQUID_AUTH_SERVER env overrides the configured value', () => {
    process.env['AC2_LIQUID_AUTH_SERVER'] = 'https://from-env.test';
    const api = {
      config: { channels: { ac2: { liquidAuthServer: 'https://from-channel.test' } } },
    } as unknown as OpenClawApi;
    expect(resolveConfig(api).liquidAuthServer).toBe('https://from-env.test');
  });

  it('ignores a blank AC2_LIQUID_AUTH_SERVER env value', () => {
    process.env['AC2_LIQUID_AUTH_SERVER'] = '   ';
    const api = {
      config: { channels: { ac2: { liquidAuthServer: 'https://from-channel.test' } } },
    } as unknown as OpenClawApi;
    expect(resolveConfig(api).liquidAuthServer).toBe('https://from-channel.test');
  });

  it('returns undefined liquidAuthServer when nothing is configured', () => {
    const api = { config: {} } as unknown as OpenClawApi;
    expect(resolveConfig(api).liquidAuthServer).toBeUndefined();
  });
});
