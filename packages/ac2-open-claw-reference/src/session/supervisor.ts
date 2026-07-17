/** Gateway-owned durable AC2 connection supervisor. */

import type { OpenClawApi, ResolvedConfig } from '../runtime.js';
import { safeLog } from '../runtime.js';
import {
  LiquidAuthChannelProvider,
  getLiquidAuthPairingErrorCode,
  isLiquidAuthPairingCredential,
  renderPairingQr,
  revokePairing,
  type LiquidAuthPairingCredential,
} from '../providers/liquid-auth.js';
import {
  clearMatchingPendingRevocation,
  discardPendingPairingIfUnestablished,
  getConnection,
  loadAc2State,
} from '../identity/state.js';
import { ensurePersistedPairing, PAIRING_INVITATION_TIMEOUT_MS } from '../identity/pairing.js';
import { sessionManager } from './manager.js';
import { runConnectedSession } from './connected-session.js';

const DEFAULT_LIQUID_AUTH_SERVER = 'https://debug.liquidauth.com';
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export type Ac2SupervisorState =
  | 'stopped'
  | 'unpaired'
  | 'revoking'
  | 'connecting'
  | 'paired_offline'
  | 'online';

export interface Ac2SupervisorStatus {
  state: Ac2SupervisorState;
  pairingId?: string;
  reconnectAttempts: number;
  lastError?: string;
}

export interface Ac2SupervisorOptions {
  api: OpenClawApi;
  config: ResolvedConfig;
  signal?: AbortSignal;
  renderQr?: (pairing: { qrPayload: string }) => void;
  random?: () => number;
  setStatus?: (status: Ac2SupervisorStatus) => void;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + random() * 0.4;
  return Math.min(MAX_RETRY_MS, Math.round(exponential * jitter));
}

/** Only an explicit unauthorized response can mean a pending invitation expired. */
export function isPairingAuthorizationError(error: unknown): boolean {
  return getLiquidAuthPairingErrorCode(error) === 'PAIRING_UNAUTHORIZED';
}

export class Ac2ConnectionSupervisor {
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private status: Ac2SupervisorStatus = { state: 'stopped', reconnectAttempts: 0 };

  getStatus(): Ac2SupervisorStatus {
    return { ...this.status };
  }

  start(options: Ac2SupervisorOptions): Promise<void> {
    if (this.running) return this.running;
    const controller = new AbortController();
    this.controller = controller;
    const onAbort = (): void => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    this.running = this.run(options, controller.signal).finally(() => {
      options.signal?.removeEventListener('abort', onAbort);
      this.controller = undefined;
      this.running = undefined;
      this.update(options, { state: 'stopped', reconnectAttempts: 0 });
    });
    return this.running;
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    try {
      sessionManager.getActive()?.transport.close();
    } catch {
      // The active transport may already be closing.
    }
    await this.running;
  }

  private update(options: Ac2SupervisorOptions, patch: Ac2SupervisorStatus): void {
    this.status = patch;
    options.setStatus?.(this.getStatus());
  }

  private async run(options: Ac2SupervisorOptions, signal: AbortSignal): Promise<void> {
    const origin =
      process.env['AC2_LIQUID_AUTH_SERVER'] ??
      options.config.liquidAuthServer ??
      DEFAULT_LIQUID_AUTH_SERVER;
    const renderQr = options.renderQr ?? renderPairingQr;
    const random = options.random ?? Math.random;
    let reconnectAttempts = 0;
    let renderedPairingId: string | undefined;

    while (!signal.aborted) {
      let persisted: ReturnType<typeof loadAc2State>;
      try {
        persisted = loadAc2State();
      } catch (error) {
        reconnectAttempts += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.update(options, {
          state: 'paired_offline',
          reconnectAttempts,
          lastError: message,
        });
        safeLog(options.api, 'error', message);
        await abortableDelay(reconnectDelayMs(reconnectAttempts, random), signal);
        continue;
      }
      const pendingRevocation = persisted.pendingRevocation;
      if (pendingRevocation) {
        this.update(options, {
          state: 'revoking',
          pairingId: pendingRevocation.pairing.pairingId,
          reconnectAttempts,
        });
        try {
          await revokePairing(
            origin,
            pendingRevocation.pairing,
            AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          );
          persisted = await clearMatchingPendingRevocation(pendingRevocation.pairing, signal);
        } catch (error) {
          if (signal.aborted) break;
          reconnectAttempts += 1;
          const message = error instanceof Error ? error.message : String(error);
          this.update(options, {
            state: 'revoking',
            pairingId: pendingRevocation.pairing.pairingId,
            reconnectAttempts,
            lastError: message,
          });
          await abortableDelay(reconnectDelayMs(reconnectAttempts, random), signal);
          continue;
        }
      }

      const state = persisted;
      const existingPairing = state.pairing;
      let attemptPairing: LiquidAuthPairingCredential | undefined;
      const attemptController = new AbortController();
      const abortAttempt = (): void => attemptController.abort();
      signal.addEventListener('abort', abortAttempt, { once: true });
      let stateWatcher: ReturnType<typeof setInterval> | undefined;
      try {
        this.update(options, {
          state: existingPairing ? 'paired_offline' : 'unpaired',
          ...(existingPairing ? { pairingId: existingPairing.pairingId } : {}),
          reconnectAttempts,
        });
        const ensured = await ensurePersistedPairing(
          origin,
          state.requestId,
          AbortSignal.any([
            attemptController.signal,
            AbortSignal.timeout(PAIRING_INVITATION_TIMEOUT_MS),
          ]),
        );
        attemptPairing = ensured.pairing;
        stateWatcher = setInterval(() => {
          let current: LiquidAuthPairingCredential | undefined;
          try {
            current = loadAc2State().pairing;
          } catch {
            attemptController.abort();
            return;
          }
          if (!current || current.credential !== attemptPairing?.credential) {
            attemptController.abort();
          }
        }, 1_000);
        const provider = new LiquidAuthChannelProvider({
          origin,
          pairing: attemptPairing,
        });
        const handle = await provider.startPairing({
          signal: attemptController.signal,
          timeoutMs: options.config.defaultTimeoutMs ?? 120_000,
        });
        const issued = handle.pairing.metadata?.['pairing'];
        if (!isLiquidAuthPairingCredential(issued)) {
          throw new Error('[ac2] Pairing provider did not return a durable credential');
        }
        const pairing: LiquidAuthPairingCredential = issued;
        // An invitation can be persisted before the signaling socket becomes
        // reachable. Render it on the first successful provider start even if
        // this retry did not create it, but never re-render an already paired
        // connection or spam the same QR during this process.
        if (
          getConnection(pairing.pairingId) === undefined &&
          renderedPairingId !== pairing.pairingId
        ) {
          renderQr(handle.pairing);
          renderedPairingId = pairing.pairingId;
        }

        this.update(options, {
          state: 'connecting',
          pairingId: pairing.pairingId,
          reconnectAttempts,
        });
        await runConnectedSession({
          api: options.api,
          config: options.config,
          connect: handle.connect,
          requestId: pairing.pairingId,
          signal: attemptController.signal,
          onState: (connectedState) => {
            if (connectedState === 'online') reconnectAttempts = 0;
            this.update(options, {
              state: connectedState === 'online' ? 'online' : 'paired_offline',
              pairingId: pairing.pairingId,
              reconnectAttempts,
            });
          },
        });
        safeLog(options.api, 'info', '[ac2] Transport offline; retaining durable pairing.');
      } catch (error) {
        if (signal.aborted) break;
        reconnectAttempts += 1;
        const message = error instanceof Error ? error.message : String(error);
        const pairingId = attemptPairing?.pairingId ?? existingPairing?.pairingId;
        let rotatePendingInvitation = false;
        if (attemptPairing !== undefined && isPairingAuthorizationError(error)) {
          try {
            rotatePendingInvitation = await discardPendingPairingIfUnestablished(
              attemptPairing,
              signal,
            );
          } catch (stateError) {
            safeLog(
              options.api,
              'error',
              stateError instanceof Error ? stateError.message : String(stateError),
            );
          }
        }
        if (rotatePendingInvitation) {
          renderedPairingId = undefined;
          safeLog(
            options.api,
            'warn',
            `[ac2] Pending invitation ${pairingId} is no longer authorized; rotating it.`,
          );
        }
        this.update(options, {
          state: pairingId && !rotatePendingInvitation ? 'paired_offline' : 'unpaired',
          ...(pairingId && !rotatePendingInvitation ? { pairingId } : {}),
          reconnectAttempts,
          lastError: message,
        });
        safeLog(options.api, 'warn', `[ac2] Connection attempt failed: ${message}`);
      } finally {
        if (stateWatcher) clearInterval(stateWatcher);
        signal.removeEventListener('abort', abortAttempt);
        attemptController.abort();
      }

      if (!signal.aborted) {
        await abortableDelay(reconnectDelayMs(Math.max(1, reconnectAttempts), random), signal);
      }
    }
  }
}

export const connectionSupervisor = new Ac2ConnectionSupervisor();
