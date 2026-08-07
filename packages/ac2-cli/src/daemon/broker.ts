/**
 * Wallet-connection broker for the AC2 daemon.
 *
 * Owns the full Liquid Auth pairing lifecycle (QR issue → handshake →
 * connected channel → reconnect/re-pair), the daemon's self-generated
 * service identity, controller binding, and message brokering between the
 * connected wallet and local agents. The daemon's control server calls the
 * broker's API and forwards its `emit(...)` notifications to subscribed
 * clients — the broker itself has no process-level concerns (no signals,
 * pidfiles, or sockets).
 */

import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { generateMessageId } from '@algorandfoundation/ac2-sdk/protocol';
import type { AC2BaseMessage } from '@algorandfoundation/ac2-sdk/schema';
import type {
  Ac2ChannelProvider,
  Ac2PairedChannel,
  Ac2PairingHandle,
} from '@algorandfoundation/ac2-sdk/signaling';
import {
  DEFAULT_TARGET_AGENT,
  type AgentRequestResult,
  type ConnectionSnapshot,
  type ConnectionState,
  type ControlEventName,
  type ControlEvents,
} from '../control/protocol.js';
import { decideControllerBinding } from '../identity/binding.js';
import { normalizeDidKey, publicKeyToDidKey, resolveStableControllerDid } from '../identity/did.js';
import {
  loadAc2State,
  saveAc2State,
  setConnectionIdentity,
  touchConnection,
  type PersistedIdentity,
} from '../identity/state.js';
import { ed25519SeedFromBase64, type Ac2KeyStore } from '../keystore/index.js';
import { ensureServiceKey } from '../identity/service-key.js';
import { bootstrapAgentIdentity, BootstrapError } from '../session/bootstrap.js';

/** Reconnect backoff bounds (capped exponential, reset on success). */
const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

/** A pairing handle that may expose persistent-signaling lifecycle hooks. */
type BrokerPairingHandle = Ac2PairingHandle & {
  isSignalingAlive?(): boolean;
  dispose?(): Promise<void>;
};

export interface ConnectionBrokerOptions {
  /**
   * Builds a channel provider for a pairing cycle. Receives the persisted
   * `requestId` (when one exists) so an already-paired wallet can reconnect
   * on the same connection without a rescan.
   */
  providerFactory: (requestId?: string) => Ac2ChannelProvider;
  /** Agent id wallet traffic is routed to (default {@link DEFAULT_TARGET_AGENT}). */
  defaultAgent?: string;
  /** Liquid Auth origin advertised in snapshots and pairing events. */
  origin: string;
  /** Keystore holding the service key and wallet-issued agent identities. */
  keystore: Ac2KeyStore;
  /** Push a control event to subscribed clients. */
  emit: <E extends ControlEventName>(event: E, data: ControlEvents[E]) => void;
  /** Optional line logger (daemon log file). */
  log?: (line: string) => void;
}

export interface ConnectionBroker {
  /** Ensure the service identity exists. Does NOT start pairing. */
  start(): Promise<void>;
  /** Start (or return the already-active) pairing cycle. */
  startPairing(opts?: {
    timeoutMs?: number;
  }): Promise<{ requestId: string; qrPayload: string; origin: string }>;
  /** Abort the active pairing cycle (keeps the broker usable). */
  stopPairing(): Promise<void>;
  /**
   * The invitation of the pairing cycle currently owned by the broker, or
   * `null` when none is armed. Purely READ-ONLY: unlike {@link startPairing}
   * it never starts (or restarts) a cycle, so a client may render the QR while
   * a wallet is connected without touching the live connection.
   */
  currentPairing(): { requestId: string; qrPayload: string; origin: string } | null;
  /**
   * Send an outbound frame to the connected wallet on behalf of an agent.
   * Works even while {@link snapshot}'s `locked` is `true`, so a locked
   * agent can still push a "not registered" notice to the wallet.
   */
  send(
    agent: string,
    channel: 'control' | 'stream',
    payload: string,
  ): Promise<{ delivered: boolean }>;
  /**
   * Broker a generic AC2 request/response round-trip against the connected
   * wallet using the daemon's OWN session `Ac2Client` — the only client that
   * receives the wallet's reply (an AC2 message routed to `onMessage`, not the
   * `onRawMessage` path that feeds `message.inbound`). Builds the request
   * envelope with `from`/`to` taken from the session's authoritative
   * agent/controller DIDs and relays the wallet's raw response back. Resolves
   * an `unavailable` (`no_identity`/`locked`) result when the session cannot
   * sign; throws when there is no connected wallet at all.
   */
  request(
    params: {
      type: string;
      body: Record<string, unknown>;
      responseTypes: readonly string[];
      expires_in_seconds?: number;
    },
    opts?: { timeoutMs?: number },
  ): Promise<AgentRequestResult>;
  /** Current wallet-connection snapshot. */
  snapshot(): ConnectionSnapshot;
  /** The daemon's own `did:key`, once {@link start} has run. */
  serviceDid(): string | null;
  /** Tear everything down (timers, channel, pairing handle). */
  stop(): Promise<void>;
}

/** Create the daemon's wallet-connection broker. */
export function createConnectionBroker(options: ConnectionBrokerOptions): ConnectionBroker {
  const defaultAgent = options.defaultAgent ?? DEFAULT_TARGET_AGENT;
  const { providerFactory, origin, keystore, emit } = options;
  const log = options.log ?? (() => {});

  let state: ConnectionState = 'idle';
  let requestId: string | null = null;
  let controllerDid: string | null = null;
  let walletAddress: string | null = null;
  let serviceDidValue: string | null = null;

  let stopped = false;
  /** Monotonic token — bumping it cancels the running pairing loop. */
  let cycleToken = 0;
  let cycleActive = false;
  let activePairing: { requestId: string; qrPayload: string; origin: string } | null = null;
  let handle: BrokerPairingHandle | null = null;
  let channel: Ac2PairedChannel | null = null;
  /**
   * The `Ac2Client` bound to the CURRENT connected session's transport. It is
   * the sole consumer of the wallet's parsed AC2 messages (it registers
   * `transport.onMessage`), so it — and only it — can settle a
   * `requestSignature` waiter with the wallet's `SigningResponse`. `null`
   * whenever no session is connected.
   */
  let sessionClient: Ac2Client | null = null;
  let locked = false;
  /** Whether the current/last session ended up with a usable agent identity. */
  let identityGranted = false;
  /** Wallet-issued DID for the default agent, when `identityGranted` is true. */
  let agentDid: string | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffWake: (() => void) | null = null;

  const setState = (next: ConnectionState): void => {
    state = next;
  };

  /** Ensure the self-generated ed25519 service key and derive its did:key. */
  const ensureServiceIdentity = async (): Promise<void> => {
    if (serviceDidValue) return;
    serviceDidValue = publicKeyToDidKey(await ensureServiceKey(keystore));
    log(`[ac2] service identity ready: ${serviceDidValue}`);
  };

  /** Persist a wallet-issued identity into the injected keystore. Best-effort. */
  const recordIdentityKey = async (params: {
    agentDid: string;
    publicKey: string;
    material: string;
  }): Promise<void> => {
    try {
      await keystore.keystore.import({
        id: params.agentDid,
        type: 'ed25519',
        algorithm: 'EdDSA',
        extractable: false,
        keyUsages: ['sign', 'verify'],
        publicKey: new Uint8Array(Buffer.from(params.publicKey, 'base64')),
        privateKey: ed25519SeedFromBase64(params.material),
      });
    } catch (err) {
      log(`[ac2] failed to persist identity key: ${(err as Error).message}`);
    }
  };

  const hasIdentityKey = (agentDid: string): boolean =>
    keystore.keys.some((key) => key.id === agentDid);

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      backoffWake = () => {
        if (backoffTimer) clearTimeout(backoffTimer);
        backoffTimer = null;
        backoffWake = null;
        resolve();
      };
      backoffTimer = setTimeout(() => {
        backoffTimer = null;
        backoffWake = null;
        resolve();
      }, ms);
    });

  const cancelBackoff = (): void => {
    backoffWake?.();
  };

  /** Begin one pairing cycle: build a provider, issue the QR, persist ids. */
  const beginPairing = async (timeoutMs?: number): Promise<BrokerPairingHandle> => {
    const persistedRequestId = loadAc2State().requestId;
    const provider = providerFactory(persistedRequestId);
    const next = (await provider.startPairing(
      timeoutMs !== undefined ? { timeoutMs } : {},
    )) as BrokerPairingHandle;
    const usedRequestId =
      typeof next.pairing.metadata?.['requestId'] === 'string'
        ? (next.pairing.metadata['requestId'] as string)
        : (persistedRequestId ?? '');
    if (usedRequestId && usedRequestId !== persistedRequestId) {
      saveAc2State({ requestId: usedRequestId });
    }
    requestId = usedRequestId || null;
    activePairing = { requestId: usedRequestId, qrPayload: next.pairing.qrPayload, origin };
    setState('pairing');
    emit('connection.pairing', activePairing);
    return next;
  };

  /** One connected session: bind identity, broker traffic, await the drop. */
  const runConnectedSession = async (active: BrokerPairingHandle): Promise<void> => {
    const paired = await active.connect();
    channel = paired;
    locked = false;
    identityGranted = false;
    agentDid = null;
    try {
      const { transport, streamChannel } = paired;
      const client = new Ac2Client(transport);
      // Expose this session's client so `requestSignature` can drive a signing
      // round-trip through the same transport that receives the reply.
      sessionClient = client;

      const connectionRequestId = requestId ?? loadAc2State().requestId ?? null;
      if (connectionRequestId) touchConnection(connectionRequestId);

      // Prefer the wallet account from the pairing link as the controller.
      const connectedAccount =
        typeof paired.peer?.['wallet'] === 'string' ? (paired.peer['wallet'] as string) : undefined;
      const connectedAccountDid =
        connectedAccount !== undefined
          ? normalizeDidKey(`did:key:${connectedAccount}`)
          : paired.peer?.did !== undefined
            ? normalizeDidKey(paired.peer.did)
            : undefined;
      walletAddress = connectedAccount ?? null;

      const persisted = loadAc2State();
      const storedIdentity =
        (connectionRequestId
          ? persisted.connections?.[connectionRequestId]?.identity
          : undefined) ?? persisted.identity;
      const boundControllerDid = persisted.identity?.controllerDid
        ? normalizeDidKey(persisted.identity.controllerDid)
        : undefined;
      const decision = decideControllerBinding({
        boundControllerDid,
        connectedAccountDid,
        hasStoredIdentity: storedIdentity !== undefined,
      });

      controllerDid = connectedAccountDid ?? null;
      if (decision === 'locked') {
        // A different wallet is connecting to an already-bound daemon: do not
        // reuse the bound identity, do not bootstrap, and do not route traffic.
        locked = true;
        identityGranted = false;
        agentDid = null;
        log(
          `[ac2] refusing controller ${connectedAccountDid} — already bound to ` +
            `${boundControllerDid}; run \`ac2 forget\` to re-register.`,
        );
      } else if (decision === 'reuse' && storedIdentity) {
        controllerDid = resolveStableControllerDid({
          storedControllerDid: storedIdentity.controllerDid,
          connectedAccountDid,
        });
        // Migrate legacy plaintext material into the keystore.
        if (storedIdentity.material && !hasIdentityKey(storedIdentity.agentDid)) {
          await recordIdentityKey({
            agentDid: storedIdentity.agentDid,
            publicKey: storedIdentity.publicKey,
            material: storedIdentity.material,
          });
        }
        identityGranted = true;
        agentDid = storedIdentity.agentDid;
        log('[ac2] reusing persisted agent identity.');
      } else {
        // Bootstrap: the wallet controller issues the default agent's keys.
        try {
          const peerDidOpt = paired.peer?.did !== undefined ? { peerDid: paired.peer.did } : {};
          const bootstrapped = await bootstrapAgentIdentity(client, peerDidOpt);
          controllerDid = connectedAccountDid ?? bootstrapped.controllerDid;
          const material = bootstrapped.response.body.material;
          if (material !== undefined) {
            await recordIdentityKey({
              agentDid: bootstrapped.agentDid,
              publicKey: bootstrapped.response.body.public_key,
              material,
            });
          }
          const grantedIdentity: PersistedIdentity = {
            agentDid: bootstrapped.agentDid,
            controllerDid,
            publicKey: bootstrapped.response.body.public_key,
          };
          if (connectionRequestId) {
            setConnectionIdentity(connectionRequestId, grantedIdentity);
          } else {
            saveAc2State({ identity: grantedIdentity });
          }
          identityGranted = true;
          agentDid = bootstrapped.agentDid;
          log(`[ac2] identity granted to ${defaultAgent}: ${bootstrapped.agentDid}`);
        } catch (err) {
          if (err instanceof BootstrapError) {
            identityGranted = false;
            agentDid = null;
            log(`[ac2] no agent identity granted: ${err.message}`);
          } else {
            throw err;
          }
        }
      }

      setState('connected');
      emit('connection.connected', {
        requestId: connectionRequestId ?? '',
        controllerDid,
        walletAddress,
        locked,
        identityGranted,
        agentDid,
      });

      // Surface the wallet's conversation (thread) lifecycle announcements.
      //
      // These arrive as AC2 protocol messages, so they are dispatched to THIS
      // client (`transport.onMessage`) and never reach the raw
      // `message.inbound` path an agent/adapter observes. Re-emitting them as
      // `conversation.changed` is what lets the active runtime adapter scope
      // its live activity and history replay to the thread the wallet is
      // actually showing — without it, everything collapses to the default
      // thread (the wallet's own `thid` on a chat frame is the only other clue,
      // and a thread switch alone sends no chat frame at all).
      const emitConversation = (kind: 'open' | 'close', msg: AC2BaseMessage): void => {
        const body = (msg.body ?? {}) as { thid?: unknown; title?: unknown };
        const thid =
          typeof body.thid === 'string' && body.thid.length > 0
            ? body.thid
            : typeof msg.thid === 'string' && msg.thid.length > 0
              ? msg.thid
              : undefined;
        if (thid === undefined) return;
        const title = typeof body.title === 'string' ? body.title : undefined;
        log(`[ac2] conversation ${kind}: ${thid}${title ? ` ("${title}")` : ''}`);
        emit('conversation.changed', {
          kind,
          thid,
          ...(title !== undefined ? { title } : {}),
          controllerDid,
          requestId: connectionRequestId,
        });
      };
      client.updateHandlers({
        'ac2/ConversationOpen': (msg) => emitConversation('open', msg),
        'ac2/ConversationClose': (msg) => emitConversation('close', msg),
      });

      // Broker inbound wallet traffic to the default agent.
      transport.onRawMessage?.((payload: string) => {
        if (locked) return;
        emit('message.inbound', {
          agent: defaultAgent,
          channel: 'control',
          payload,
          controllerDid,
          requestId: connectionRequestId,
        });
      });
      if (streamChannel) {
        streamChannel.onmessage = (ev: { data: unknown }) => {
          const raw = ev.data;
          if (locked || typeof raw !== 'string' || raw.trim().length === 0) return;
          emit('message.inbound', {
            agent: defaultAgent,
            channel: 'stream',
            payload: raw,
            controllerDid,
            requestId: connectionRequestId,
          });
        };
      }

      // Hold the session open until the channel drops.
      const reason = await new Promise<string>((resolve) => {
        transport.onClose(() => resolve('channel closed'));
        transport.onError((err) => resolve(`channel error: ${err.message}`));
        if (streamChannel) streamChannel.onclose = () => resolve('stream channel closed');
      });
      emit('connection.disconnected', { requestId: connectionRequestId, reason });
    } finally {
      channel = null;
      // A dropped session's client can no longer sign; drop it so
      // `requestSignature` reports "not connected" rather than dispatching
      // onto a dead transport.
      sessionClient = null;
      // A dropped session can never claim a granted identity going stale in
      // `snapshot()`/`daemon.status` — clear it until the next session decides.
      locked = false;
      identityGranted = false;
      agentDid = null;
      try {
        await paired.close();
      } catch {
        // Already closed; ignore.
      }
    }
  };

  /**
   * Pairing/reconnect loop (generalizes the reference plugin's re-pair loop):
   * after a drop, reuse the live handle when its signaling socket survived,
   * otherwise dispose it and rebuild a fresh cycle with capped exponential
   * backoff (reset on success).
   */
  const runCycleLoop = async (
    first: BrokerPairingHandle,
    token: number,
    timeoutMs?: number,
  ): Promise<void> => {
    let active = first;
    while (!stopped && token === cycleToken) {
      try {
        await runConnectedSession(active);
      } catch (err) {
        log(`[ac2] session failed: ${(err as Error).message}`);
        if (requestId !== null || loadAc2State().requestId) {
          emit('connection.disconnected', {
            requestId: requestId ?? loadAc2State().requestId ?? null,
            reason: `session failed: ${(err as Error).message}`,
          });
        }
      }
      if (stopped || token !== cycleToken) break;

      if (active.isSignalingAlive?.() ?? false) {
        // Signaling survived: re-arm connect() on the same handle so the
        // wallet re-links in place (no rescan).
        setState('reconnecting');
        log('[ac2] wallet link dropped — signaling alive, awaiting re-link.');
        continue;
      }

      // Signaling died: dispose and rebuild with capped exponential backoff.
      setState('reconnecting');
      try {
        await active.dispose?.();
      } catch {
        // Already torn down; ignore.
      }
      let backoffMs = BACKOFF_INITIAL_MS;
      let rebuilt: BrokerPairingHandle | null = null;
      while (!stopped && token === cycleToken) {
        try {
          rebuilt = await beginPairing(timeoutMs);
          break;
        } catch (err) {
          log(`[ac2] failed to restart pairing; retrying in ${backoffMs}ms: ${err}`);
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        }
      }
      if (!rebuilt) break;
      active = rebuilt;
      handle = rebuilt;
    }
  };

  /** Tear down the current cycle (handle + channel), leaving state 'idle'. */
  const teardownCycle = async (): Promise<void> => {
    cycleToken += 1;
    cycleActive = false;
    activePairing = null;
    locked = false;
    identityGranted = false;
    agentDid = null;
    cancelBackoff();
    const current = channel;
    channel = null;
    if (current) {
      try {
        await current.close();
      } catch {
        // Already closed; ignore.
      }
    }
    const currentHandle = handle;
    handle = null;
    if (currentHandle) {
      try {
        await currentHandle.dispose?.();
      } catch {
        // Already torn down; ignore.
      }
    }
    setState('idle');
  };

  return {
    async start(): Promise<void> {
      await ensureServiceIdentity();
    },

    async startPairing(opts?: {
      timeoutMs?: number;
    }): Promise<{ requestId: string; qrPayload: string; origin: string }> {
      if (stopped) throw new Error('[ac2] broker is stopped');
      if (cycleActive && activePairing) return activePairing;
      await ensureServiceIdentity();
      cycleActive = true;
      const token = ++cycleToken;
      try {
        handle = await beginPairing(opts?.timeoutMs);
      } catch (err) {
        cycleActive = false;
        throw err;
      }
      void runCycleLoop(handle, token, opts?.timeoutMs);
      return activePairing!;
    },

    async stopPairing(): Promise<void> {
      await teardownCycle();
    },

    currentPairing(): { requestId: string; qrPayload: string; origin: string } | null {
      return activePairing;
    },

    async send(
      _agent: string,
      channelName: 'control' | 'stream',
      payload: string,
    ): Promise<{ delivered: boolean }> {
      // Intentionally NOT gated on `locked`: a locked agent still needs to be
      // able to push a "not registered" notice to the wallet, even though
      // inbound traffic from that wallet is being dropped.
      const current = channel;
      if (!current || state !== 'connected') return { delivered: false };
      try {
        if (channelName === 'stream') {
          const stream = current.streamChannel;
          if (!stream || stream.readyState !== 'open') return { delivered: false };
          stream.send(payload);
          return { delivered: true };
        }
        if (!current.transport.isOpen) return { delivered: false };
        current.transport.send(payload);
        return { delivered: true };
      } catch {
        return { delivered: false };
      }
    },

    async request(
      params: {
        type: string;
        body: Record<string, unknown>;
        responseTypes: readonly string[];
        expires_in_seconds?: number;
      },
      opts: { timeoutMs?: number } = {},
    ): Promise<AgentRequestResult> {
      // No live session → there is nothing to broker through. Throw (rather
      // than returning a result) so the daemon maps it to a `not_connected`
      // control error and the agent knows to pair, not that the user declined.
      if (state !== 'connected' || !sessionClient) {
        throw new Error('[ac2] no connected wallet to send an AC2 request to');
      }
      // A refused (locked) or un-bootstrapped session has no usable identity —
      // report it as a daemon-side gate that never reached the wallet.
      if (locked) {
        return { status: 'unavailable', reason: 'locked' };
      }
      if (!identityGranted || agentDid === null || controllerDid === null) {
        return { status: 'unavailable', reason: 'no_identity' };
      }

      // Build the request envelope with the session's authoritative identity;
      // the caller cannot spoof `from`/`to`. The daemon stays verb-agnostic —
      // it neither inspects nor validates `type`/`body` beyond relaying them.
      const message: AC2BaseMessage = {
        id: generateMessageId(),
        type: params.type,
        from: agentDid,
        to: [controllerDid],
        created_time: Math.floor(Date.now() / 1000),
        body: params.body,
        ...(params.expires_in_seconds !== undefined
          ? { expires_time: Math.floor(Date.now() / 1000) + params.expires_in_seconds }
          : {}),
      };
      const timeoutMs = opts.timeoutMs ?? 120_000;
      const reply = await sessionClient.request(message, {
        responseTypes: params.responseTypes,
        timeoutMs,
      });
      return {
        status: 'response',
        message: {
          type: reply.type,
          from: reply.from,
          to: reply.to,
          body: reply.body as Record<string, unknown>,
          ...(reply.thid !== undefined ? { thid: reply.thid } : {}),
        },
      };
    },

    snapshot(): ConnectionSnapshot {
      return { state, requestId, controllerDid, walletAddress, origin, locked };
    },

    serviceDid(): string | null {
      return serviceDidValue;
    },

    async stop(): Promise<void> {
      stopped = true;
      await teardownCycle();
    },
  };
}
