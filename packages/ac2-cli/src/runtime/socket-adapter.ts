/**
 * Built-in default runtime adapter: the pre-existing "route inbound wallet
 * frames to the control-socket endpoint registered for the target agent"
 * behaviour, now reached through the `Ac2RuntimeAdapter` seam
 * (`@algorandfoundation/ac2-sdk/runtime`) instead of being wired directly
 * into the daemon's event fan-out.
 *
 * This is the ONLY implementation of "deliver an inbound wallet frame to a
 * control-socket agent endpoint" left in the codebase — a daemon with no
 * `runtime` configured resolves to this adapter (see `../runtime/loader.ts`),
 * so its behaviour must stay byte-for-byte identical to what `daemon/run.ts`
 * used to do inline.
 */

import type { Ac2RuntimeAdapter, Ac2RuntimeHost, Ac2RuntimeInbound } from '@algorandfoundation/ac2-sdk/runtime';

/** Short name this built-in resolves under, and the daemon's default adapter id. */
export const SOCKET_RUNTIME_ADAPTER_ID = 'socket';

/**
 * Extension of {@link Ac2RuntimeHost} the daemon hands ONLY to the built-in
 * `socket` adapter — never to a loaded third-party adapter, and not part of
 * the published `@algorandfoundation/ac2-sdk/runtime` contract. A
 * third-party adapter only ever sees a plain `Ac2RuntimeHost`; it has no way
 * to reach a control-socket endpoint directly (by design — that coupling is
 * specific to this one built-in).
 */
export interface SocketRuntimeHost extends Ac2RuntimeHost {
  /**
   * Deliver an inbound wallet frame to whichever control-socket connection
   * is currently registered (via `agent.hello`) for `host.agent`. A no-op
   * when nothing is registered — exactly like the fan-out this replaces.
   */
  deliverInboundToAgentSocket(message: Ac2RuntimeInbound): void;
}

/** Narrow a generic host down to {@link SocketRuntimeHost}. */
function isSocketRuntimeHost(host: Ac2RuntimeHost): host is SocketRuntimeHost {
  return typeof (host as Partial<SocketRuntimeHost>).deliverInboundToAgentSocket === 'function';
}

/**
 * Construct the built-in `socket` adapter. Only ever called by
 * `../runtime/loader.ts` for the `socket` built-in name, with a host built
 * by `daemon/run.ts` that always satisfies {@link SocketRuntimeHost}.
 */
export function createSocketRuntimeAdapter(host: Ac2RuntimeHost): Ac2RuntimeAdapter {
  if (!isSocketRuntimeHost(host)) {
    // Can only happen if a future caller wires the `socket` built-in without
    // going through `daemon/run.ts`'s host construction — fail loudly rather
    // than silently dropping every inbound frame.
    throw new Error(
      '[ac2] the "socket" runtime adapter requires the daemon-internal host wiring ' +
        '(deliverInboundToAgentSocket) and cannot be constructed with a plain Ac2RuntimeHost.',
    );
  }
  return {
    id: SOCKET_RUNTIME_ADAPTER_ID,
    handleInbound(message: Ac2RuntimeInbound): void {
      host.deliverInboundToAgentSocket(message);
    },
  };
}
