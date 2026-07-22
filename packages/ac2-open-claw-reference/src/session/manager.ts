/** Holds the single active `ac2` channel session. Tools route through `requireActive()`. */

import type { Ac2Client } from '@algorandfoundation/ac2-sdk';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';
import type { Sendable } from '../channel/stream.js';

export interface ActiveSession {
  readonly transport: Ac2Transport;
  readonly client: Ac2Client;
  /**
   * The `ac2-stream` control-frame surface (the stream DataChannel), when the
   * wallet negotiated one. Host-initiated outbound sends (e.g. a sub-agent
   * completion announce delivered through the channel's `message`/`outbound`
   * adapters) use this to emit thread-scoped `finalize` frames instead of a
   * raw, thread-less transport write. Falls back to `transport` when absent.
   */
  readonly controlTransport?: Sendable;
  /** Controller (wallet) DID, from `KeyResponse.from` during bootstrap. */
  readonly controllerDid: string;
  /** Agent DID, derived from the bootstrap `KeyResponse.public_key`. */
  readonly agentDid: string;
  /** Liquid Auth pairing id (`requestId`) for this connection. */
  readonly requestId?: string;
  /** Raw Algorand wallet account from the Liquid Auth link response. */
  readonly walletAddress?: string;
  /** True once the wallet granted the agent an identity (bootstrap `KeyRequest`). */
  readonly identityGranted?: boolean;
  /**
   * True when a *different* controller connected to an agent already bound to
   * another one. The session stays open only to explain the lock — inbound
   * messages are NOT routed to the agent, and no identity is granted — until
   * the operator clears the agent's keys under `~/.openclaw` (`ac2 forget`).
   */
  readonly locked?: boolean;
}

export class SessionManager {
  private active: ActiveSession | null = null;

  setActive(session: ActiveSession): void {
    this.active = session;
  }

  clearActive(): void {
    this.active = null;
  }

  getActive(): ActiveSession | null {
    return this.active;
  }

  requireActive(): ActiveSession {
    if (!this.active) {
      throw new NoActiveSessionError(
        'No active AC2 channel session. Ask the user to open and connect their wallet on the `ac2` channel first.',
      );
    }
    return this.active;
  }
}

export class NoActiveSessionError extends Error {
  readonly code = 'no_active_session' as const;
  constructor(message: string) {
    super(message);
    this.name = 'NoActiveSessionError';
  }
}

/** Module-scoped singleton populated by the channel, read by the tools. */
export const sessionManager = new SessionManager();
