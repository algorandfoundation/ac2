/**
 * Top-level barrel for `@algorandfoundation/ac2-sdk`.
 *
 * This barrel intentionally re-exports only the four namespaces. The full
 * symbol surface lives behind subpath exports — ESM consumers should prefer
 * importing directly from those:
 *
 * ```ts
 * import { Ac2Client } from '@algorandfoundation/ac2-sdk/protocol';
 * import { rtcDataChannelTransport } from '@algorandfoundation/ac2-sdk/transport';
 * ```
 *
 * CJS consumers (or anyone who wants a single entry point) can reach the
 * same symbols via the namespaces:
 *
 * ```ts
 * import * as ac2 from '@algorandfoundation/ac2-sdk';
 * const client = new ac2.protocol.Ac2Client(transport);
 * ```
 */
export * as schema from './schema/index.js';
export * as protocol from './protocol/index.js';
export * as transport from './transport/index.js';
export * as signaling from './signaling/index.js';

// `Ac2Client` is the primary entry point for the SDK. It is also reachable
// via `ac2.protocol.Ac2Client`, but is re-exported here directly so the
// common `import { Ac2Client } from '@algorandfoundation/ac2-sdk'` works
// without a subpath.
export { Ac2Client } from './client.js';
export type { Ac2ClientOptions } from './client.js';
