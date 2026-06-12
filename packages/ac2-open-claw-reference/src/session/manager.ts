/** Holds the single active `ac2` channel session. Tools route through `requireActive()`. */

import type { Ac2Client } from '@algorandfoundation/ac2-sdk';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';

export interface ActiveSession {
  readonly transport: Ac2Transport;
  readonly client: Ac2Client;
  /** Controller (wallet) DID, from `KeyResponse.from` during bootstrap. */
  readonly controllerDid: string;
  /** Agent DID, derived from the bootstrap `KeyResponse.public_key`. */
  readonly agentDid: string;
  /** Liquid Auth pairing id (`requestId`) for this connection. */
  readonly requestId?: string;
  /** True once the wallet granted the agent an identity (bootstrap `KeyRequest`). */
  readonly identityGranted?: boolean;
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
