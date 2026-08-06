/**
 * Runtime-adapter loader for the AC2 daemon.
 *
 * Resolves a `runtime.adapter` specifier (see `daemon/run.ts`) to a
 * constructed `Ac2RuntimeAdapter` (`@algorandfoundation/ac2-sdk/runtime`).
 *
 * Resolution precedence — checked in this order, and documented here
 * because it determines whether a third party can ever shadow a built-in:
 *
 *   1. Built-in short name (see {@link BUILTIN_RUNTIME_ADAPTERS}). No
 *      filesystem or module resolution happens at all; this is a plain
 *      lookup in a static, in-process table.
 *   2. Otherwise, `specifier` is treated as an npm package specifier and
 *      dynamically `import()`-ed.
 *
 * Built-ins are checked FIRST and unconditionally, so a package published
 * under the name `socket` (or any other built-in name) can never be loaded
 * in its place — `socket` always means the built-in.
 *
 * Every failure — package not found, missing/wrong-typed
 * `createRuntimeAdapter` export, the factory throwing, or the factory
 * returning something that isn't a valid `Ac2RuntimeAdapter` — throws ONE
 * `Error` naming `specifier` and the concrete fix. The daemon
 * (`daemon/run.ts`) is responsible for catching that, logging it, and
 * continuing with no adapter attached: a broken third-party adapter must
 * never crash the daemon or drop the wallet connection.
 */

import type {
  Ac2RuntimeAdapter,
  Ac2RuntimeConnectionInfo,
  Ac2RuntimeHost,
} from '@algorandfoundation/ac2-sdk/runtime';
import type { ControlEvents } from '../control/protocol.js';
import { createSocketRuntimeAdapter, SOCKET_RUNTIME_ADAPTER_ID } from './socket-adapter.js';
import {
  createOpenClawGatewayAdapter,
  OPENCLAW_GATEWAY_RUNTIME_ADAPTER_ID,
} from './gateway/adapter.js';

/**
 * Compile-time pin between `Ac2RuntimeConnectionInfo` (SDK) and
 * `ControlEvents['connection.connected']` (CLI): the SDK duplicates the
 * control-event shape rather than importing it (see the JSDoc on
 * `Ac2RuntimeConnectionInfo`), so this assertion is the only thing standing
 * between the two silently drifting apart. If either shape changes without
 * the other, this line fails to type-check (`tsc --noEmit`), not a runtime
 * assertion — there is nothing to check at runtime, the types either match
 * or they don't.
 */
type AssertSameShape<A, B> = A extends B ? (B extends A ? true : never) : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ConnectionInfoMatchesControlEvent = AssertSameShape<
  Ac2RuntimeConnectionInfo,
  ControlEvents['connection.connected']
>;
const _connectionInfoMatchesControlEvent: _ConnectionInfoMatchesControlEvent = true;
void _connectionInfoMatchesControlEvent;

/** Adapter id the daemon resolves to when nothing else is configured. */
export const DEFAULT_RUNTIME_ADAPTER = SOCKET_RUNTIME_ADAPTER_ID;

type BuiltinAdapterFactory = (
  host: Ac2RuntimeHost,
  config: Record<string, unknown>,
) => Ac2RuntimeAdapter | Promise<Ac2RuntimeAdapter>;

/** Short names resolvable with no npm install. Checked before any package resolution. */
const BUILTIN_RUNTIME_ADAPTERS: Readonly<Record<string, BuiltinAdapterFactory>> = {
  [SOCKET_RUNTIME_ADAPTER_ID]: (host) => createSocketRuntimeAdapter(host),
  [OPENCLAW_GATEWAY_RUNTIME_ADAPTER_ID]: (host, config) => createOpenClawGatewayAdapter(host, config),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Structural validation of a value returned by a loaded `createRuntimeAdapter`. */
function isValidRuntimeAdapter(value: unknown): value is Ac2RuntimeAdapter {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string' || value['id'].length === 0) return false;
  if (typeof value['handleInbound'] !== 'function') return false;
  for (const optionalHook of ['start', 'onConnected', 'onDisconnected', 'stop'] as const) {
    if (optionalHook in value && typeof value[optionalHook] !== 'function') return false;
  }
  return true;
}

/**
 * Resolve and construct a runtime adapter for `specifier`. See the
 * module-level JSDoc for resolution precedence and the error contract.
 */
export async function loadRuntimeAdapter(
  specifier: string,
  host: Ac2RuntimeHost,
  config: Record<string, unknown> = {},
): Promise<Ac2RuntimeAdapter> {
  const builtin = BUILTIN_RUNTIME_ADAPTERS[specifier];
  if (builtin) {
    return builtin(host, config);
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `[ac2] failed to load runtime adapter "${specifier}": the package could not be imported ` +
        `(${(err as Error).message}). Install it (e.g. \`npm install ${specifier}\`), or check ` +
        'the specifier for a typo.',
    );
  }

  const factory = mod['createRuntimeAdapter'];
  if (typeof factory !== 'function') {
    throw new Error(
      `[ac2] runtime adapter "${specifier}" does not export a "createRuntimeAdapter" function. ` +
        'A loadable adapter package must export `createRuntimeAdapter(host, config)` — see ' +
        '`@algorandfoundation/ac2-sdk/runtime`.',
    );
  }

  let adapter: unknown;
  try {
    adapter = await (factory as (...args: unknown[]) => unknown)(host, config);
  } catch (err) {
    throw new Error(
      `[ac2] runtime adapter "${specifier}" threw while creating the adapter: ` +
        `${(err as Error).message}. Fix the adapter package's createRuntimeAdapter(host, config).`,
    );
  }

  if (!isValidRuntimeAdapter(adapter)) {
    throw new Error(
      `[ac2] runtime adapter "${specifier}" returned an invalid adapter: expected an object with ` +
        'a non-empty string `id` and a `handleInbound` function (plus optionally `start`, ' +
        '`onConnected`, `onDisconnected`, `stop` as functions).',
    );
  }

  return adapter;
}
