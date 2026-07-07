/** The `ac2` shell + slash command: `pair`, `status`, `connections`, `forget`. */

import qrcode from 'qrcode-terminal';
import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { isValidAddress } from '@algorandfoundation/algokit-utils/common';
import { resolveConfig, safeLog, type OpenClawApi } from '../runtime.js';
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
import { normalizeDidKey } from '../identity/did.js';
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
  sendFinalize,
  setActiveConversation,
  warmUpAgent,
} from '../channel/index.js';

/** Chat notice shown when the wallet has not granted the agent an identity. */
const NO_IDENTITY_NOTICE =
  "I don't have an identity yet. To work with you securely I need my own " +
  'dedicated key — a `did:key` identity your wallet issues to me. It lets me ' +
  'prove who I am on this channel and sign my own messages, and it is kept ' +
  'separate from your personal accounts and keys (I never see or use those). ' +
  'Until you grant one, I can chat with you but cannot perform signing-related ' +
  'actions. When you are ready, approve the identity request in your wallet to ' +
  'continue.';

function isMissingWebRtcError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  return message.includes('@roamhq/wrtc') || message.includes('wrtc');
}

function webRtcUnavailableInstructions(): string {
  return [
    'AC2 pairing could not load the @roamhq/wrtc WebRTC module for this platform.',
    '',
    '@roamhq/wrtc ships prebuilt binaries, so this usually means the matching',
    'platform package was not installed. Reinstall the plugin to fetch it:',
    '',
    '```bash',
    'openclaw plugins install npm:@algorandfoundation/ac2-open-claw-reference@next --force',
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
        const active = sessionManager.getActive();
        const lines = ['Channel: ac2', `Online: ${active ? 'yes' : 'no'}`];
        if (active) {
          lines.push(`Agent DID: ${active.agentDid}`);
          lines.push(`Controller DID: ${active.controllerDid}`);
          if (active.requestId) lines.push(`Connection: ${active.requestId}`);
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
          // Reuse a persisted requestId so the wallet reconnects to the same connection.
          const persistedRequestId = loadAc2State().requestId;
          const { LiquidAuthChannelProvider } = await import('../providers/liquid-auth.js');
          const provider: import('@algorandfoundation/ac2-sdk/signaling').Ac2ChannelProvider =
            new LiquidAuthChannelProvider({
              origin,
              ...(persistedRequestId ? { requestId: persistedRequestId } : {}),
            });
          const handle = await provider.startPairing({
            timeoutMs: cfg.defaultTimeoutMs ?? 120_000,
          });
          const usedRequestId = handle.pairing.metadata?.['requestId'];
          if (typeof usedRequestId === 'string' && usedRequestId.length > 0) {
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
                : connected.peer?.did;

            // Reuse a stored identity for this connection, otherwise bootstrap.
            const storedIdentity =
              (connectionRequestId
                ? loadAc2State().connections?.[connectionRequestId]?.identity
                : undefined) ?? loadAc2State().identity;
            // Placeholders — overridden on a granted identity, else session goes active
            // with `identityGranted = false` so the agent can explain.
            let agentDid = 'did:ac2:agent';
            let controllerDid = connectedAccountDid ?? 'did:key:zAc2Controller';
            let identityGranted = true;
            if (storedIdentity) {
              ({ agentDid } = storedIdentity);
              controllerDid = connectedAccountDid ?? storedIdentity.controllerDid;
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
            sessionManager.setActive({
              transport,
              client,
              controllerDid,
              agentDid,
              identityGranted,
              ...(walletAddress ? { walletAddress } : {}),
              ...(connectionRequestId ? { requestId: connectionRequestId } : {}),
            });
            safeLog(
              api,
              'info',
              `[ac2] Channel paired and active. agentDid=${agentDid} controllerDid=${controllerDid}`,
            );

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

            // Replay threads + default-thread history for reconnecting controllers.
            replayConversationList(controlSendable, connectionRequestId);
            replayConversationHistory(controlSendable, connectionRequestId, DEFAULT_THID);

            if (!identityGranted) {
              sendFinalize(
                controlSendable,
                DEFAULT_THID,
                `ac2-noid-${Date.now()}`,
                NO_IDENTITY_NOTICE,
              );
            }

            if (streamTransport) {
              streamTransport.onmessage = async (event: { data: unknown }) => {
                const raw = event.data;
                if (typeof raw === 'string' && raw.trim().length > 0) {
                  const active = sessionManager.getActive()!;
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
            try {
              cycle = await startPairingCycle();
              console.log('\n' + buildInvitationText(cycle.pairing, cycle.qrString));
            } catch (err) {
              safeLog(api, 'error', `[ac2] Failed to restart pairing: ${err}`);
              break;
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
