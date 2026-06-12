/**
 * OpenClaw setup entry for the `ac2` channel
 * (`openclaw.setupEntry: "./dist/setup.index.js"`). Built on
 * `defineBundledChannelSetupEntry`; never boots the channel runtime.
 */

import { defineBundledChannelSetupEntry } from 'openclaw/plugin-sdk/channel-entry-contract';

import {
  AC2_CHANNEL_ENV_VARS,
  CHANNEL_ID,
  PLUGIN_ID,
  cmdSetup,
  readChannelStatus,
} from './config.js';

const SETUP_DESCRIPTION =
  'Reference OpenClaw plugin for the AC2 protocol. Set up / status the `ac2` ' +
  'channel (pairing over Liquid Auth + WebRTC) without booting the channel runtime.';

const bundledSetupEntry = defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: { specifier: './channel.plugin.js', exportName: 'channelPlugin' },
});

/** Setup entry augmented with `id` / `channels` / `channelEnvVars` / `status` / `setup`. */
export const setupEntry = {
  ...bundledSetupEntry,
  id: PLUGIN_ID,
  name: 'AC2 Reference',
  description: SETUP_DESCRIPTION,
  channels: [CHANNEL_ID],
  channelEnvVars: AC2_CHANNEL_ENV_VARS,
  status: readChannelStatus,
  setup: cmdSetup,
};

export default setupEntry;

export { cmdSetup, readChannelStatus, AC2_CHANNEL_ENV_VARS };
