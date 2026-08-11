/** The `ac2` shell + slash command: `pair`, `status`, `connections`, `forget`. */

import qrcode from 'qrcode-terminal';
import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { resolveConfig, safeLog, type OpenClawApi } from '../runtime.js';
import { readChannelStatus } from '../setup/config.js';
import { sessionManager } from '../session/manager.js';
import type { Sendable } from '../channel/stream.js';
import { listConversations } from '@algorandfoundation/ac2-cli/identity';
import {
  connectAgentSession,
  connectControl,
  createDaemonStreamSendable,
  createDaemonTransport,
  resolveLogFilePath,
  type AgentSession,
  type ControlClient,
  type ControlEvents,
} from '@algorandfoundation/ac2-cli/control';
import { sendNotice } from '../channel/index.js';

/**
 * Banner notice shown when the wallet has not granted the agent an identity
 * yet. Surfaced only as a banner (not a chat message), so the wallet can also
 * block new messages until an identity is granted. Kept short.
 */
const NO_IDENTITY_NOTICE =
  "This agent has no identity yet and isn't registered to this wallet. Approve " +
  'the identity request in your wallet to register and start chatting.';

/**
 * Banner notice shown when a *different* controller (wallet) connects to an
 * agent that is already registered to another one. The agent refuses to be
 * taken over: it will not reuse or regenerate its identity for the new wallet.
 * To let a new wallet take over, the operator must clear the agent's keys
 * (`ac2 forget`). Kept short — it is surfaced only as a banner, not a chat
 * message.
 */
const CONTROLLER_LOCKED_NOTICE =
  "This agent is already registered to another wallet and won't switch " +
  'automatically. To let this wallet take over, the operator must clear the ' +
  'agent keys on the server (`ac2 forget`).';

const ROAMHQ_WRTC_PACKAGE_PATTERN = /@roamhq\/wrtc(?:-[a-z0-9-]+)?/i;

/**
 * Detect a "missing `@roamhq/wrtc`" failure reported by the AC2 daemon while
 * starting a Liquid Auth pairing cycle.
 *
 * The daemon (not this plugin) is the process that actually loads WebRTC now,
 * so this failure arrives here as a `ControlRequestError` from
 * `session.startPairing()` — the daemon's original NodeJS error (with its
 * `code`, e.g. `ERR_MODULE_NOT_FOUND`) never crosses the control socket: the
 * protocol normalizes every daemon-side failure to a generic error code and
 * keeps only the message text (see `control/server.ts`'s `toErrorMessage`).
 * Matching is therefore message-only.
 */
export function isMissingWebRtcError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const message = err.message;
  const looksLikeModuleLoadFailure =
    /cannot find (package|module)/i.test(message) && ROAMHQ_WRTC_PACKAGE_PATTERN.test(message);
  const looksLikeMissingBinary =
    message.startsWith('Could not find wrtc binary on any of the paths:') &&
    ROAMHQ_WRTC_PACKAGE_PATTERN.test(message);

  return looksLikeModuleLoadFailure || looksLikeMissingBinary;
}

function webRtcUnavailableInstructions(): string {
  return [
    'AC2 pairing could not load the @roamhq/wrtc WebRTC module for this platform.',
    '',
    '@roamhq/wrtc ships prebuilt binaries, so this usually means the matching',
    'platform package was not installed with the AC2 service. The service is',
    'bundled with this plugin, so refresh it by reinstalling the plugin and',
    'restarting the gateway (this pulls the platform-specific optional deps):',
    '',
    '```bash',
    'openclaw plugins update ac2',
    'openclaw gateway restart',
    'openclaw ac2 pair',
    '```',
    '',
    'If this persists, this platform may not have a published @roamhq/wrtc prebuilt binary.',
  ].join('\n');
}

/** Shown when `pair` could not reach the daemon, even after trying to auto-start it. */
function daemonUnreachableText(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return [
    'Could not reach the AC2 daemon (auto-start was attempted and failed).',
    '',
    `Reason: ${reason}`,
    '',
    'Start it manually and check the log for details:',
    '  ac2 service start',
    `  ${resolveLogFilePath()}`,
  ].join('\n');
}

/** Render a Liquid Auth pairing payload as a QR + raw URL invitation. */
async function buildInvitationText(pairing: { qrPayload: string }): Promise<string> {
  const qr = await new Promise<string>((resolve) => {
    qrcode.generate(pairing.qrPayload, { small: true }, (rendered) => resolve(rendered));
  });
  return [
    'AC2 Pairing Invitation',
    '',
    qr,
    '',
    `Pairing URL: ${pairing.qrPayload}`,
    '',
    'Scan the QR code with your AC2 Controller. The channel will activate once paired.',
  ].join('\n');
}

/**
 * Render the invitation of the pairing cycle the daemon ALREADY owns.
 *
 * `daemon.status` exposes it read-only, so this never starts (or restarts) a
 * cycle — which is what makes it safe to show a scannable code even while a
 * wallet is connected: the daemon keeps the cycle and its `requestId` armed so
 * the wallet can re-link without a fresh cycle being minted here. Returns
 * `undefined` when no cycle is armed yet, or when the status read fails
 * (purely cosmetic, never fatal).
 */
async function renderCurrentInvitation(session: AgentSession): Promise<string | undefined> {
  try {
    const status = await session.status();
    if (!status.pairing) return undefined;
    return await buildInvitationText(status.pairing);
  } catch {
    return undefined;
  }
}

/**
 * Reconstruct the equivalent of a `connection.connected` event from a session
 * that was ALREADY connected at `agent.hello` time — there is no event to
 * wait on in that case, since it fired (for a different control-socket
 * client) before this process even started.
 */
function synthesizeConnectedEvent(session: AgentSession): ControlEvents['connection.connected'] | null {
  const conn = session.connection;
  // A connected snapshot always carries its requestId; the null-check keeps the
  // (wider) snapshot type and the (narrower) event type honest.
  if (conn.state !== 'connected' || conn.requestId === null) return null;
  return {
    requestId: conn.requestId,
    controllerDid: conn.controllerDid,
    walletAddress: conn.walletAddress,
    locked: conn.locked,
    identityGranted: session.identity !== null,
    agentDid: session.identity?.agentDid ?? null,
  };
}

/** Connect to the daemon control socket read-only; `undefined` if it isn't running. */
async function connectReadOnly(): Promise<ControlClient | undefined> {
  try {
    return await connectControl({ timeoutMs: 500 });
  } catch {
    return undefined;
  }
}

function daemonNotRunningText(): string {
  return [
    'AC2 daemon is not running (this is a read-only command, so it was not auto-started).',
    '',
    'Start it with: ac2 service start',
    `Log file: ${resolveLogFilePath()}`,
  ].join('\n');
}

export function buildAc2Command(api: OpenClawApi): unknown {
  return {
    name: 'ac2',
    description: 'AC2 channel control (pair, status, forget).',
    acceptsArgs: true,
    requireAuth: false,
    async handler(ctx: any): Promise<{ text: string; keepAlive?: boolean }> {
      const args = (ctx.args ?? '').trim();
      const tokens = args.split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? 'pair';

      if (sub === 'status') {
        const channelStatus = readChannelStatus();
        const lines = [
          'Channel: ac2',
          `Config: ${channelStatus.configPath}`,
          `Plugin allow-listed: ${channelStatus.pluginAllowed ? 'yes' : 'no'}`,
          `Plugin enabled: ${channelStatus.pluginEnabled ? 'yes' : 'no'}`,
          `Bound to agent: ${channelStatus.bound ? 'yes' : 'no'}`,
          `Ready: ${channelStatus.ready ? 'yes' : 'no'}`,
          `Liquid Auth server: ${channelStatus.liquidAuthServer} (${channelStatus.liquidAuthServerSource})`,
        ];

        const client = await connectReadOnly();
        if (!client) {
          lines.push('', daemonNotRunningText());
          return { text: lines.join('\n') };
        }
        try {
          const status = await client.request('daemon.status', {});
          const { connections } = await client.request('connections.list', {});
          lines.push(`Daemon: running (pid ${status.pid})`);
          lines.push(`Daemon service DID: ${status.serviceDid ?? '(none yet)'}`);
          lines.push(`Online: ${status.connection.state === 'connected' ? 'yes' : 'no'}`);
          if (status.connection.state === 'connected') {
            const active = connections.find((c) => c.requestId === status.connection.requestId);
            if (active?.agentDid) lines.push(`Agent DID: ${active.agentDid}`);
            lines.push(`Controller DID: ${status.connection.controllerDid ?? '(unknown)'}`);
            if (status.connection.requestId) lines.push(`Connection: ${status.connection.requestId}`);
            if (status.connection.locked) {
              lines.push(
                'Locked: yes (a different wallet is connecting; run `ac2 forget` to re-register)',
              );
            }
          }
          lines.push(`Known connections: ${connections.length}`);
        } finally {
          client.close();
        }
        return { text: lines.join('\n') };
      }

      if (sub === 'connections') {
        const client = await connectReadOnly();
        if (!client) return { text: daemonNotRunningText() };
        try {
          const { connections } = await client.request('connections.list', {});
          if (connections.length === 0) {
            return { text: 'No connections recorded yet.' };
          }
          const status = await client.request('daemon.status', {});
          const activeRequestId =
            status.connection.state === 'connected' ? status.connection.requestId : null;
          const lines: string[] = [`AC2 connections (${connections.length}):`, ''];
          for (const conn of connections) {
            const isActive = activeRequestId === conn.requestId;
            lines.push(`• ${conn.requestId}${isActive ? '  [active]' : ''}`);
            if (conn.agentDid) {
              lines.push(`    agent DID:      ${conn.agentDid}`);
              lines.push(`    controller DID: ${conn.controllerDid}`);
            } else {
              lines.push('    (no identity granted yet)');
            }
            // Conversation history still lives in the shared AC2 state dir
            // (see the `channel/conversation.ts` import below) — both the
            // daemon and this plugin write it. Follow-up: move it behind a
            // `connections.*` control method so the plugin never touches the
            // state dir directly.
            const conversations = listConversations(conn.requestId);
            lines.push(`    conversations:  ${conversations.length}`);
            for (const convo of conversations) {
              const title = convo.title ?? '(untitled)';
              lines.push(`      - ${convo.thid}: "${title}" (${convo.messages.length} msgs)`);
            }
            lines.push('');
          }
          return { text: lines.join('\n').trimEnd() };
        } finally {
          client.close();
        }
      }

      if (sub === 'forget') {
        sessionManager.clearActive();
        const client = await connectReadOnly();
        if (!client) {
          return { text: `${daemonNotRunningText()}\n\nNothing to forget locally.` };
        }
        try {
          await client.request('connections.forget', { all: true });
          return { text: 'Pairing record cleared.' };
        } finally {
          client.close();
        }
      }

      if (sub === 'pair') {
        const cfg = resolveConfig(api);

        /**
         * Commit new pairings to the AC2 daemon's built-in `openclaw-gateway`
         * runtime adapter instead of the legacy `socket` adapter, so the
         * daemon drives the whole run/reply lifecycle over the gateway and
         * pushes replies to the wallet itself.
         *
         * (a) `ensureDaemonRunning`/`connectAgentSession` below auto-start the
         *     daemon by spawning `node <cli> service run` with `env: process.env`
         *     (see ac2-cli's `control/agent.ts`), so a freshly spawned daemon
         *     inherits this env var directly — nothing else needs to change here.
         * (b) The actual gateway connection (`OPENCLAW_GATEWAY_URL` /
         *     `OPENCLAW_GATEWAY_PORT` / `OPENCLAW_GATEWAY_TOKEN`) is resolved by
         *     the daemon's `openclaw-gateway` adapter from ITS OWN inherited
         *     env/defaults. There is no host-API gateway lookup in this plugin
         *     to wire up — do not invent one.
         * (c) The adapter is fixed when the daemon starts and cannot be
         *     swapped in place, so an ALREADY-running daemon on a different
         *     adapter would leave the wallet paired to a service with no live
         *     agent behind it (it pairs, reports "connected", and every turn
         *     goes nowhere). `ensureDaemonRunning` therefore compares this
         *     env var against the running daemon's reported adapter and
         *     restarts a self-managed daemon that disagrees — a service left
         *     over from a bare `ac2 service start` (legacy `socket` adapter)
         *     is recycled automatically. An OS-supervised daemon (no pidfile)
         *     is only reported: restart its service unit to apply the change.
         * (d) Operators can opt back out at any time with `AC2_RUNTIME=socket`
         *     set before the daemon starts, to roll back to the legacy
         *     in-process-routed adapter.
         */
        process.env['AC2_RUNTIME'] ??= 'openclaw-gateway';

        const timeoutOpt =
          cfg.defaultTimeoutMs !== undefined ? { timeoutMs: cfg.defaultTimeoutMs } : {};

        let session: AgentSession;
        try {
          session = await connectAgentSession({
            agent: 'openclaw',
            host: 'openclaw',
            autoStart: true,
            ...timeoutOpt,
          });
        } catch (err) {
          return { text: daemonUnreachableText(err) };
        }

        // A single control-socket transport/client for the WHOLE command's
        // lifetime: unlike the old embedded path, the daemon owns reconnects,
        // so `transport`/`client` are never rebuilt across a wallet drop —
        // only `sessionManager`'s active session flips on `connection.*`.
        const transport = createDaemonTransport(session);
        // Wallets that negotiated no `ac2-stream` DataChannel make every
        // stream-channel send undeliverable; re-send those frames on the main
        // transport so control frames (notices, replays, previews) are never
        // silently dropped — the embedded path had the same fallback, it just
        // knew up front whether a stream channel existed.
        const streamSendable = createDaemonStreamSendable(session, {
          onUndeliverable: (payload) => transport.send(payload),
        });
        const client = new Ac2Client(transport);

        // Prefer the dedicated stream channel for surfacing notices, exactly
        // like the delivery path in `channel-object.ts` does — it carries
        // control frames (preview/finalize/notice/…) separately from the main
        // AC2 protocol transport.
        const replySendable = (): Sendable => (streamSendable.isOpen ? streamSendable : transport);

        const activate = (event: ControlEvents['connection.connected']): void => {
          const controllerDid = event.controllerDid ?? 'did:key:zAc2Controller';
          const agentDid = event.agentDid ?? 'did:ac2:agent';
          const requestId = event.requestId ?? undefined;
          const walletAddress = event.walletAddress ?? undefined;

          sessionManager.setActive({
            transport,
            client,
            controllerDid,
            agentDid,
            identityGranted: event.identityGranted,
            locked: event.locked,
            controlTransport: streamSendable,
            ...(walletAddress !== undefined ? { walletAddress } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
          });
          safeLog(
            api,
            'info',
            `[ac2] Channel paired and active. agentDid=${agentDid} controllerDid=${controllerDid}`,
          );

          const reply = replySendable();
          if (event.locked) {
            // A foreign wallet is locked out: surface a banner only (no chat
            // message). The daemon's `openclaw-gateway` adapter is the one
            // deciding whether to route this connection's turns to the
            // agent — this plugin only surfaces the banner here.
            sendNotice(reply, {
              code: 'controller_locked',
              level: 'warning',
              title: 'New wallet not registered',
              text: CONTROLLER_LOCKED_NOTICE,
            });
          } else {
            if (!event.identityGranted) {
              // Not registered (no identity granted yet): surface a banner
              // only (no chat message). The wallet uses this code to block
              // new messages until an identity is granted.
              sendNotice(reply, {
                code: 'identity_missing',
                level: 'warning',
                title: 'Not registered',
                text: NO_IDENTITY_NOTICE,
              });
            }
          }
        };

        session.on('connection.connected', activate);
        session.on('connection.disconnected', (event) => {
          safeLog(
            api,
            'info',
            `[ac2] Wallet disconnected (${event.reason}). The daemon owns reconnect — waiting for ` +
              'the next connection.',
          );
          sessionManager.clearActive();
        });

        const already = synthesizeConnectedEvent(session);
        if (already) {
          /**
           * Already paired AND connected: there is nothing for this command to
           * do, so report the live session and EXIT instead of holding the
           * shell open. Holding would be pointless — the daemon owns the
           * connection, its reconnects and (under the `openclaw-gateway`
           * adapter) the whole run/reply lifecycle, so this process is not
           * required for the wallet to keep working.
           *
           * Deliberately no `activate(...)` here: the local `sessionManager`
           * (and the notice frames it would push) only live as long as this
           * process, which is about to exit — and the daemon already surfaces
           * lock/identity state to the wallet itself. The lock hint below is
           * printed for the operator instead.
           */
          const lines = [
            'AC2 daemon already has an active wallet connection — session is active.',
            '',
            `Controller DID: ${already.controllerDid ?? '(unknown)'}`,
          ];
          if (already.agentDid) lines.push(`Agent DID:      ${already.agentDid}`);
          if (already.walletAddress) lines.push(`Wallet:         ${already.walletAddress}`);
          if (already.locked) {
            lines.push(
              '',
              'Locked: a different wallet is connected — run `openclaw ac2 forget` to re-register.',
            );
          }
          // Show the live invitation anyway: `pair` is the command an operator
          // reaches for to get a code, and the daemon keeps its cycle armed
          // while connected, so there is always something scannable to render.
          const invitation = await renderCurrentInvitation(session);
          if (invitation) lines.push('', invitation);
          lines.push(
            '',
            'Nothing to do — the daemon owns this connection. Use `openclaw ac2 status` to inspect it,',
            'or `openclaw ac2 forget` to drop the pairing and re-pair.',
          );
          // Release the control socket so the process can exit immediately: no
          // `keepAlive`, since there is no pairing to wait for.
          await session.close();
          return { text: lines.join('\n') };
        }

        let pairing: { requestId: string; qrPayload: string; origin: string };
        try {
          pairing = await session.startPairing(timeoutOpt);
        } catch (err) {
          if (isMissingWebRtcError(err)) {
            return { text: webRtcUnavailableInstructions() };
          }
          const reason = err instanceof Error ? err.message : String(err);
          return {
            text: [
              'AC2 daemon rejected the pairing request.',
              '',
              `Reason: ${reason}`,
              '',
              `Check the daemon log for details: ${resolveLogFilePath()}`,
            ].join('\n'),
          };
        }

        // A rebuilt pairing cycle (e.g. after a signaling-server outage) mints
        // a fresh QR — re-render it so the operator can rescan.
        session.on('connection.pairing', (p) => {
          void (async () => {
            // eslint-disable-next-line no-console
            console.log('\n' + (await buildInvitationText(p)));
          })();
        });

        return { text: await buildInvitationText(pairing), keepAlive: true };
      }

      return { text: `Unknown subcommand: ${sub}. Use 'pair', 'status', or 'forget'.` };
    },
  };
}
