/** Lazily-loaded channel-plugin sidecar referenced by the entry / setup entry. */

import { buildChannelObject } from './index.js';

/**
 * The `ac2` channel object. No `default` export — the SDK loader unwraps a
 * module's `default` first and then looks for the named export *inside* that
 * value, so adding a default here would break resolution.
 */
export const channelPlugin = buildChannelObject();
