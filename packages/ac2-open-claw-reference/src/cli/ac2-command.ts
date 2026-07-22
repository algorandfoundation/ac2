/** The `ac2` shell + slash command: `pair`, `status`, `connections`, `forget`. */

import qrcode from 'qrcode-terminal';
import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { isValidAddress } from '@algorandfoundation/algokit-utils/common';
import { resolveConfig, safeLog, type OpenClawApi } from '../runtime.js';
import { readChannelStatus } from '../setup/config.js';
import { BootstrapError, bootstrapAgentIdentity } from '../session/bootstrap.js';
import type { ChannelContext } from '../session/contracts.js';
import { sessionManager } from '../session/manager.js';
import {
  clearAc2State,
  ensureConversation,
  listConnections,
  listConversations,
  loadAc2State,
  saveAc2State,
  setConnectionIdentity,
  touchConnection,
} from '../identity/state.js';
import { normalizeDidKey, resolveStableControllerDid } from '../identity/did.js';
import { decideControllerBinding } from '../identity/binding.js';
import {
  clearAgentIdentities,
  hasAgentIdentity,
  recordAgentIdentity,
} from '../identity/keystore.js';
import {
  DEFAULT_THID,
  clearActiveConversation,
  replayConversationHistory,
  replayConversationList,
  routeInboundToAgent,
  sendNotice,
  setActiveConversation,
  warmUpAgent,
} from '../channel/index.js';

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

const NODE_MODULE_LOAD_ERROR_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
const ROAMHQ_WRTC_PACKAGE_PATTERN = /@roamhq\/wrtc(?:-[a-z0-9-]+)?/i;

/**
 * Decide whether to seed the *stable* connection id from a freshly-minted
 * Liquid Auth `requestId`.
 *
 * The Liquid Auth `requestId` is a one-shot pairing nonce: once a wallet has
 * linked and the WebRTC session has been established, that same id can no
 * longer be re-linked. We therefore let the provider mint a fresh `requestId`
 * on every pairing cycle, but keep a single stable connection id — seeded from
 * the very first pairing — to key on-disk persistence (identity, conversation
 * history). Only seed it when one is not already persisted, so reconnects never
 * rotate the connection id (and never orphan its history).
 */
export function shouldSeedConnectionId(
  persistedConnectionId: string | undefined,
  usedRequestId: unknown,
): usedRequestId is string {
  return (
    (persistedConnectionId === undefined || persistedConnectionId.length === 0) &&
    typeof usedRequestId === 'string' &&
    usedRequestId.length > 0
  );
}

export function isMissingWebRtcError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const message = err.message;
  const code = (err as { code?: unknown }).code;
  const isNodeModuleLoadError =
    typeof code === 'string' &&
    NODE_MODULE_LOAD_ERROR_CODES.has(code) &&
    ROAMHQ_WRTC_PACKAGE_PATTERN.test(message);

  const isMissingWrtcBinary =
    message.startsWith('Could not find wrtc binary on any of the paths:') &&
    ROAMHQ_WRTC_PACKAGE_PATTERN.test(message);

  return isNodeModuleLoadError || isMissingWrtcBinary;
}

function webRtcUnavailableInstructions(): string {
  return [
    'AC2 pairing could not load the @roamhq/wrtc WebRTC module for this platform.',
    '',
    '@roamhq/wrtc ships prebuilt binaries, so this usually means the matching',
    'platform package was not installed. Reinstall the plugin to fetch it:',
    '',
    '```bash',
    'openclaw plugins install npm:@algorandfoundation/ac2-open-claw-reference --force',
    'openclaw plugins enable ac2',
    '```',
    '',
    'If this persists, this platform may not have a published @roamhq/wrtc prebuilt binary.',
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
        const active = sessionManager.getActive();
        const lines = [
          'Channel: ac2',
          `Config: ${channelStatus.configPath}`,
          `Plugin allow-listed: ${channelStatus.pluginAllowed ? 'yes' : 'no'}`,
          `Plugin enabled: ${channelStatus.pluginEnabled ? 'yes' : 'no'}`,
          `Bound to agent: ${channelStatus.bound ? 'yes' : 'no'}`,
          `Ready: ${channelStatus.ready ? 'yes' : 'no'}`,
          `Liquid Auth server: ${channelStatus.liquidAuthServer} (${channelStatus.liquidAuthServerSource})`,
          `Online: ${active ? 'yes' : 'no'}`,
        ];
        if (active) {
          lines.push(`Agent DID: ${active.agentDid}`);
          lines.push(`Controller DID: ${active.controllerDid}`);
          if (active.requestId) lines.push(`Connection: ${active.requestId}`);
          if (active.locked) {
            lines.push(
              'Locked: yes (a different wallet is connecting; run `ac2 forget` to re-register)',
            );
          }
        }
        const connections = listConnections();
        lines.push(`Known connections: ${connections.length}`);
        return { text: lines.join('\n') };
      }

      if (sub === 'connections') {
        const connections = listConnections();
        if (connections.length === 0) {
          return { text: 'No connections recorded yet.' };
        }
        const active = sessionManager.getActive();
        const lines: string[] = [`AC2 connections (${connections.length}):`, ''];
        for (const conn of connections) {
          const isActive = active?.requestId === conn.requestId;
          lines.push(`• ${conn.requestId}${isActive ? '  [active]' : ''}`);
          if (conn.identity) {
            lines.push(`    agent DID:      ${conn.identity.agentDid}`);
            lines.push(`    controller DID: ${conn.identity.controllerDid}`);
            lines.push(`    public key:     ${conn.identity.publicKey}`);
            lines.push(
              `    has material:   ${hasAgentIdentity(conn.identity.agentDid) ? 'yes (keystore)' : 'no'}`,
            );
          } else {
            lines.push('    (no identity granted yet)');
          }
          const conversations = listConversations(conn.requestId);
          lines.push(`    conversations:  ${conversations.length}`);
          for (const convo of conversations) {
            const title = convo.title ?? '(untitled)';
            lines.push(`      - ${convo.thid}: "${title}" (${convo.messages.length} msgs)`);
          }
          lines.push('');
        }
        return { text: lines.join('\n').trimEnd() };
      }

      if (sub === 'forget') {
        sessionManager.clearActive();
        clearAc2State();
        clearAgentIdentities();
        return { text: 'Pairing record cleared.' };
      }

      if (sub === 'pair') {
        const cfg = resolveConfig(api);

        // Warm up the runtime while the user is scanning the QR.
        await warmUpAgent(api, '__warmup__');

        const origin = cfg.liquidAuthServer ?? 'https://debug.liquidauth.com';
        const startPairingCycle = async (): Promise<{
          pairing: import('@algorandfoundation/ac2-sdk/signaling').Ac2PairingInfo;
          connect: () => Promise<import('@algorandfoundation/ac2-sdk/signaling').Ac2PairedChannel>;
          qrString: string;
        }> => {
          // Reuse the persisted Liquid Auth requestId across pairing cycles so
          // a previously-paired wallet can reconnect without re-running its
          // FIDO2 passkey assertion — mirroring the debug app, which keeps a
          // stable requestId and just renegotiates. The signaling server now
          // supports reconnecting on the same requestId (presence + `auth`
          // re-announce + an always-waiting `link`), so the id is no longer a
          // one-shot nonce: the wallet remembers the requestId it authenticated
          // for and re-links to it, and the server re-announces the wallet's
          // `auth` so this offer side resolves and both peers just renegotiate
          // the WebRTC session (no new passkey). On the very first pairing there
          // is nothing persisted yet, so the provider mints a fresh id which is
          // then seeded as the stable connection id (see `shouldSeedConnectionId`)
          // and reused on every subsequent cycle.
          const persistedConnectionId = loadAc2State().requestId;
          const { LiquidAuthChannelProvider } = await import('../providers/liquid-auth.js');
          const provider: import('@algorandfoundation/ac2-sdk/signaling').Ac2ChannelProvider =
            new LiquidAuthChannelProvider({
              origin,
              ...(persistedConnectionId ? { requestId: persistedConnectionId } : {}),
            });
          const handle = await provider.startPairing({
            timeoutMs: cfg.defaultTimeoutMs ?? 120_000,
          });
          const usedRequestId = handle.pairing.metadata?.['requestId'];
          if (shouldSeedConnectionId(persistedConnectionId, usedRequestId)) {
            saveAc2State({ requestId: usedRequestId });
          }
          const qr = await new Promise<string>((resolve) => {
            qrcode.generate(handle.pairing.qrPayload, { small: true }, (rendered) => {
              resolve(rendered);
            });
          });
          return { pairing: handle.pairing, connect: handle.connect, qrString: qr };
        };

        const buildInvitationText = (
          pairing: import('@algorandfoundation/ac2-sdk/signaling').Ac2PairingInfo,
          qrString: string,
        ): string =>
          [
            'AC2 Pairing Invitation',
            '',
            qrString,
            '',
            `Pairing URL: ${pairing.qrPayload}`,
            '',
            'Scan the QR code with your AC2 Controller. The channel will activate once paired.',
          ].join('\n');

        let firstCycle: Awaited<ReturnType<typeof startPairingCycle>>;
        try {
          firstCycle = await startPairingCycle();
        } catch (err) {
          if (isMissingWebRtcError(err)) {
            return { text: webRtcUnavailableInstructions() };
          }
          throw err;
        }

        const context: ChannelContext = {
          logger: {
            info: (m) => safeLog(api, 'info', m),
            error: (m) => safeLog(api, 'error', m),
          },
          async receive(text) {
            // Routing happens in `transport.onRawMessage` below.
            safeLog(api, 'info', `Received chat from wallet: ${text}`);
          },
          onOutput(_handler) {
            // Outbound is wired by the channel object's `sendText`.
          },
        };

        const runConnectedSession = async (
          connect: () => Promise<import('@algorandfoundation/ac2-sdk/signaling').Ac2PairedChannel>,
        ): Promise<void> => {
          let paired: import('@algorandfoundation/ac2-sdk/signaling').Ac2PairedChannel | undefined;
          try {
            const connected = await connect();
            paired = connected;
            const { transport, streamChannel: streamTransport } = connected;
            const client = new Ac2Client(transport);

            const connectionRequestId = loadAc2State().requestId;
            if (connectionRequestId) touchConnection(connectionRequestId);

            const peerDidOpt =
              connected.peer?.did !== undefined ? { peerDid: connected.peer.did } : {};
            const timeoutOpt =
              cfg.defaultTimeoutMs !== undefined ? { timeoutMs: cfg.defaultTimeoutMs } : {};

            // Prefer the wallet from the Liquid Auth `link` response as `controllerDid`.
            const connectedAccount =
              typeof connected.peer?.['wallet'] === 'string'
                ? (connected.peer['wallet'] as string)
                : undefined;
            const walletAddress =
              connectedAccount !== undefined && isValidAddress(connectedAccount)
                ? connectedAccount
                : undefined;
            const connectedAccountDid =
              connectedAccount !== undefined
                ? normalizeDidKey(`did:key:${connectedAccount}`)
                : connected.peer?.did !== undefined
                  ? normalizeDidKey(connected.peer.did)
                  : undefined;

            // Reuse a stored identity for this connection, otherwise bootstrap.
            const storedIdentity =
              (connectionRequestId
                ? loadAc2State().connections?.[connectionRequestId]?.identity
                : undefined) ?? loadAc2State().identity;
            // The controller this agent install is already registered to (the
            // first wallet that ever granted it an identity). A *different*
            // controller must not be able to take over — see `decideControllerBinding`.
            const boundControllerDid = loadAc2State().identity?.controllerDid
              ? normalizeDidKey(loadAc2State().identity!.controllerDid)
              : undefined;
            const bindingDecision = decideControllerBinding({
              boundControllerDid,
              connectedAccountDid,
              hasStoredIdentity: storedIdentity !== undefined,
            });
            // Placeholders — overridden on a granted identity, else session goes active
            // with `identityGranted = false` so the agent can explain.
            let agentDid = 'did:ac2:agent';
            let controllerDid = connectedAccountDid ?? 'did:key:zAc2Controller';
            let identityGranted = true;
            let locked = false;
            if (bindingDecision === 'locked') {
              // A different wallet is connecting to an already-registered agent.
              // Refuse the takeover: do NOT reuse the bound identity and do NOT
              // bootstrap a fresh one. Route the (blocked) session under the
              // foreign controller's own DID so nothing can touch the bound
              // controller's OpenClaw session/context.
              locked = true;
              identityGranted = false;
              controllerDid = connectedAccountDid ?? 'did:key:zAc2Controller';
              safeLog(
                api,
                'warn',
                `[ac2] Refusing controller ${connectedAccountDid} — agent is already registered ` +
                  `to ${boundControllerDid}. Operator must clear keys (\`ac2 forget\`) to re-register.`,
              );
            } else if (bindingDecision === 'reuse' && storedIdentity) {
              ({ agentDid } = storedIdentity);
              // Anchor the session key (`ac2:<controllerDid>:<thid>`) to the
              // identity bound at grant time so a presence-only reconnect —
              // which may omit the wallet address and fall back to a
              // differently-encoded peer DID — cannot rotate `controllerDid`
              // and make the agent reload a different, empty OpenClaw session
              // (i.e. "forget" the thread's context).
              controllerDid = resolveStableControllerDid({
                storedControllerDid: storedIdentity.controllerDid,
                connectedAccountDid,
              });
              if (
                connectedAccountDid !== undefined &&
                connectedAccountDid !== storedIdentity.controllerDid
              ) {
                safeLog(
                  api,
                  'warn',
                  `[ac2] linked account ${connectedAccountDid} differs from the granted ` +
                    `controller ${storedIdentity.controllerDid}; keeping the granted identity ` +
                    'to preserve conversation context.',
                );
              }
              // Migrate legacy plaintext material into the keystore.
              if (storedIdentity.material && !hasAgentIdentity(agentDid)) {
                await recordAgentIdentity({
                  agentDid,
                  publicKey: storedIdentity.publicKey,
                  material: storedIdentity.material,
                });
              }
              safeLog(api, 'info', '[ac2] Reusing persisted agent identity.');
            } else {
              let bootstrapped: Awaited<ReturnType<typeof bootstrapAgentIdentity>> | undefined;
              try {
                bootstrapped = await bootstrapAgentIdentity(client, {
                  ...peerDidOpt,
                  ...timeoutOpt,
                });
              } catch (err) {
                if (err instanceof BootstrapError) {
                  identityGranted = false;
                  safeLog(
                    api,
                    'warn',
                    `[ac2] No agent identity granted: ${err.message}. Keeping channel open to explain.`,
                  );
                } else {
                  throw err;
                }
              }
              if (bootstrapped) {
                agentDid = bootstrapped.agentDid;
                // Refuse to bind on a `KeyResponse.from` mismatch — a spoofed `from`
                // is a security failure, not a missing identity.
                if (
                  connectedAccountDid !== undefined &&
                  bootstrapped.controllerDid !== connectedAccountDid
                ) {
                  throw new BootstrapError(
                    `[ac2-open-claw] KeyResponse.from (${bootstrapped.controllerDid}) does not match ` +
                    `the linked account (${connectedAccountDid}); refusing to grant identity.`,
                  );
                }
                controllerDid = connectedAccountDid ?? bootstrapped.controllerDid;
                const material = bootstrapped.response.body.material;
                if (material !== undefined) {
                  await recordAgentIdentity({
                    agentDid,
                    publicKey: bootstrapped.response.body.public_key,
                    material,
                  });
                }
                const grantedIdentity = {
                  agentDid,
                  controllerDid,
                  publicKey: bootstrapped.response.body.public_key,
                };
                if (connectionRequestId) {
                  setConnectionIdentity(connectionRequestId, grantedIdentity);
                } else {
                  saveAc2State({ identity: grantedIdentity });
                }
              }
            }
            // Adapter to give `streamChannel` a `send` + `isOpen` surface.
            const streamSendable = streamTransport
              ? {
                send: (payload: string) => streamTransport.send(payload),
                get isOpen() {
                  return streamTransport.readyState === 'open';
                },
              }
              : undefined;
            const controlSendable = streamSendable ?? transport;

            sessionManager.setActive({
              transport,
              client,
              controllerDid,
              agentDid,
              identityGranted,
              locked,
              // The stream control surface used by host-initiated outbound sends
              // (e.g. sub-agent completion announces) to emit thread-scoped
              // `finalize` frames instead of raw, thread-less transport writes.
              ...(streamSendable ? { controlTransport: streamSendable } : {}),
              ...(walletAddress ? { walletAddress } : {}),
              ...(connectionRequestId ? { requestId: connectionRequestId } : {}),
            });
            safeLog(
              api,
              'info',
              `[ac2] Channel paired and active. agentDid=${agentDid} controllerDid=${controllerDid}`,
            );

            client.updateHandlers({
              'ac2/ConversationOpen': (msg) => {
                const openThid =
                  typeof (msg.body as any)?.thid === 'string' && (msg.body as any).thid.length > 0
                    ? ((msg.body as any).thid as string)
                    : msg.thid;
                if (!openThid) return;
                const title =
                  typeof (msg.body as any)?.title === 'string'
                    ? ((msg.body as any).title as string)
                    : undefined;
                setActiveConversation(controllerDid, openThid, connectionRequestId);
                if (connectionRequestId) ensureConversation(connectionRequestId, openThid, title);
                safeLog(
                  api,
                  'info',
                  `[ac2] Conversation opened (thid=${openThid}${title ? `, title="${title}"` : ''}).`,
                );
                replayConversationHistory(controlSendable, connectionRequestId, openThid);
              },
              'ac2/ConversationClose': (msg) => {
                const closeThid =
                  typeof (msg.body as any)?.thid === 'string' && (msg.body as any).thid.length > 0
                    ? ((msg.body as any).thid as string)
                    : msg.thid;
                if (!closeThid) return;
                clearActiveConversation(controllerDid, closeThid, connectionRequestId);
                safeLog(api, 'info', `[ac2] Conversation closed (thid=${closeThid}).`);
              },
            });

            if (locked) {
              // A foreign wallet is locked out: surface a banner only (no chat
              // message), and DO NOT replay the bound controller's history to
              // it. Routing is also blocked below, so the agent never sees its
              // messages.
              sendNotice(controlSendable, {
                code: 'controller_locked',
                level: 'warning',
                title: 'New wallet not registered',
                text: CONTROLLER_LOCKED_NOTICE,
              });
            } else {
              // Replay threads + default-thread history for reconnecting controllers.
              replayConversationList(controlSendable, connectionRequestId);
              replayConversationHistory(controlSendable, connectionRequestId, DEFAULT_THID);

              if (!identityGranted) {
                // Not registered (no identity granted yet): surface a banner
                // only (no chat message). The wallet uses this code to block
                // new messages until an identity is granted.
                sendNotice(controlSendable, {
                  code: 'identity_missing',
                  level: 'warning',
                  title: 'Not registered',
                  text: NO_IDENTITY_NOTICE,
                });
              }
            }

            if (streamTransport) {
              streamTransport.onmessage = async (event: { data: unknown }) => {
                const raw = event.data;
                if (typeof raw === 'string' && raw.trim().length > 0) {
                  const active = sessionManager.getActive()!;
                  // A locked (foreign-wallet) session never reaches the agent —
                  // re-surface the lock notice instead of routing its messages.
                  if (active.locked) {
                    sendNotice(streamSendable!, {
                      code: 'controller_locked',
                      level: 'warning',
                      title: 'New wallet not registered',
                      text: CONTROLLER_LOCKED_NOTICE,
                    });
                    return;
                  }
                  await routeInboundToAgent(
                    api,
                    raw,
                    streamSendable!,
                    active.controllerDid,
                    active.requestId,
                  );
                }
              };
            }
            transport.onRawMessage?.(async (text: string) => {
              const active = sessionManager.getActive()!;
              if (active.locked) {
                sendNotice(streamSendable ?? transport, {
                  code: 'controller_locked',
                  level: 'warning',
                  title: 'New wallet not registered',
                  text: CONTROLLER_LOCKED_NOTICE,
                });
                return;
              }
              await routeInboundToAgent(
                api,
                text,
                streamSendable ?? transport,
                active.controllerDid,
                active.requestId,
              );
            });

            await new Promise<void>((resolve) => {
              transport.onClose(() => resolve());
              transport.onError(() => resolve());
              if (streamTransport) (streamTransport as any).onclose = () => resolve();
            });
          } catch (err) {
            safeLog(api, 'error', `[ac2] Pairing failed: ${err}`);
          } finally {
            sessionManager.clearActive();
            if (paired) await paired.close();
          }
        };

        void (async () => {
          let cycle = firstCycle;
          // Re-pairing loop: re-render the QR after a dropped DataChannel.
          // eslint-disable-next-line no-constant-condition
          while (true) {
            await runConnectedSession(cycle.connect);
            safeLog(
              api,
              'info',
              '[ac2] DataChannel closed — waiting for the controller to re-link. Scan the QR code again.',
            );
            // Retry with capped exponential backoff instead of giving up: a
            // transient signaling-server/network outage should self-heal so
            // pairing resumes automatically once conditions improve.
            let backoffMs = 2_000;
            // eslint-disable-next-line no-constant-condition
            while (true) {
              try {
                cycle = await startPairingCycle();
                console.log('\n' + buildInvitationText(cycle.pairing, cycle.qrString));
                break;
              } catch (err) {
                safeLog(
                  api,
                  'warn',
                  `[ac2] Failed to restart pairing; retrying in ${backoffMs}ms: ${err}`,
                );
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
                backoffMs = Math.min(backoffMs * 2, 30_000);
              }
            }
          }
        })();

        return {
          text: buildInvitationText(firstCycle.pairing, firstCycle.qrString),
          keepAlive: true,
        };
      }

      return { text: `Unknown subcommand: ${sub}. Use 'pair', 'status', or 'forget'.` };
    },
  };
}
