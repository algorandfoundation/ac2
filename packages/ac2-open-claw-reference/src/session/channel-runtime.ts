/** Long-running channel runtime: pair via Liquid Auth, then hold the DataChannel open. */

import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { isValidAddress } from '@algorandfoundation/algokit-utils/common';
import type { Ac2ChannelProvider, Ac2PairedChannel } from '@algorandfoundation/ac2-sdk/signaling';
import qrcode from 'qrcode-terminal';
import type { ChannelContext, PluginConfig } from './contracts.js';
import { SessionManager, sessionManager } from './manager.js';
import { bootstrapAgentIdentity } from './bootstrap.js';
import { buildFinalizeFrame } from './flows.js';

const DEFAULT_LIQUID_AUTH_SERVER = 'https://debug.liquidauth.com';

const NO_IDENTITY_NOTICE =
  "⚠️ I don't have an identity key yet, so I can't sign or act on your behalf. " +
  'Please approve the identity (key) request in your AC2 Controller to grant me one. ' +
  'You can keep chatting in the meantime — signing is disabled until then.';

function linkedWalletAddress(paired: Ac2PairedChannel): string | undefined {
  const wallet = (paired.peer as { wallet?: unknown } | undefined)?.wallet;
  return typeof wallet === 'string' && isValidAddress(wallet) ? wallet : undefined;
}

function resolveLiquidAuthServer(config: PluginConfig): string | undefined {
  const fromEnv = typeof process !== 'undefined' ? process.env?.AC2_LIQUID_AUTH_SERVER : undefined;
  return fromEnv ?? config.liquidAuthServer ?? undefined;
}

/** Render a pairing payload to the terminal (QR + raw string). */
export function renderPairingQr(pairing: { qrPayload: string }): void {
  const isTty = typeof process !== 'undefined' && Boolean(process.stdout?.isTTY);
  if (isTty) qrcode.generate(pairing.qrPayload, { small: true });
  // eslint-disable-next-line no-console
  console.log(`[ac2-open-claw] Pair with Controller: ${pairing.qrPayload}`);
}

export interface ChannelDeps {
  /** Channel bringup provider; defaults to `LiquidAuthChannelProvider`. */
  provider?: Ac2ChannelProvider;
  renderQr?: typeof renderPairingQr;
  /** Override the module session manager (tests). */
  manager?: SessionManager;
}

/** Pair, bootstrap identity, then hold the DataChannel open until signaled. */
export async function runAc2Channel(
  config: PluginConfig,
  deps: ChannelDeps,
  context: ChannelContext,
): Promise<void> {
  const origin = resolveLiquidAuthServer(config) ?? DEFAULT_LIQUID_AUTH_SERVER;
  const provider: Ac2ChannelProvider =
    deps.provider ??
    new (await import('../providers/liquid-auth.js')).LiquidAuthChannelProvider({ origin });
  const renderQr = deps.renderQr ?? renderPairingQr;
  const manager = deps.manager ?? sessionManager;

  const { pairing, connect } = await provider.startPairing({
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
    timeoutMs: config.defaultTimeoutMs ?? 120_000,
  });
  context.logger?.info(`[ac2-open-claw] channel pairing started: ${pairing.qrPayload}`);
  renderQr(pairing);

  let paired: Ac2PairedChannel | undefined;
  try {
    context.signal?.throwIfAborted();
    paired = await connect();
    const { transport, streamChannel: streamTransport } = paired;
    const client = new Ac2Client(transport);

    // Control-frame surface used by host-initiated outbound sends (e.g.
    // sub-agent completion announces) to emit thread-scoped `finalize` frames.
    const streamSendable = streamTransport
      ? {
          send: (payload: string) => streamTransport.send(payload),
          get isOpen() {
            return streamTransport.readyState === 'open';
          },
        }
      : undefined;

    // Agent → wallet (prefer `ac2-stream` when present).
    const sendChat = async (text: string): Promise<void> => {
      if (streamTransport && streamTransport.readyState === 'open') {
        streamTransport.send(buildFinalizeFrame(text));
      } else if (transport.isOpen) {
        transport.send(text);
      }
    };
    context.onOutput(async (text) => {
      await sendChat(text);
    });

    // Wallet → agent (wired before bootstrap so chat works immediately).
    transport.onRawMessage?.(async (text: string) => {
      await context.receive(text);
    });
    if (streamTransport) {
      streamTransport.onmessage = async (event: any) => {
        const raw = event.data;
        if (typeof raw === 'string' && raw.trim().length > 0) {
          await context.receive(raw);
        }
      };
    }

    // Identity bootstrap. Failure is non-fatal — chat stays open, signing locked.
    const peerDidOpt = paired.peer?.did !== undefined ? { peerDid: paired.peer.did } : {};
    const walletAddress = linkedWalletAddress(paired);
    const timeoutOpt =
      config.defaultTimeoutMs !== undefined ? { timeoutMs: config.defaultTimeoutMs } : {};
    try {
      const { agentDid, controllerDid } = await bootstrapAgentIdentity(client, {
        ...peerDidOpt,
        ...timeoutOpt,
      });
      context.logger?.info(
        `[ac2-open-claw] bootstrap complete: agentDid=${agentDid} controllerDid=${controllerDid}`,
      );

      manager.setActive({
        transport,
        client,
        controllerDid,
        agentDid,
        identityGranted: true,
        ...(streamSendable ? { controlTransport: streamSendable } : {}),
        ...(walletAddress !== undefined ? { walletAddress } : {}),
      });
      context.logger?.info('[ac2-open-claw] channel connected; tools are live');
    } catch (err) {
      context.logger?.error(
        `[ac2-open-claw] identity bootstrap failed; signing tools stay disabled: ${(err as Error).message}`,
      );
      // The transport is up and the wallet is chatting, so the channel IS
      // connected — register the session anyway (with `identityGranted: false`)
      // instead of leaving it inactive. Otherwise `sessionManager.getActive()`
      // stays null and the channel/tools report "registered but not online" /
      // `no_active_session` even while the user is actively chatting. Signing
      // stays gated on `identityGranted` (see `signFlow`), so the agent can
      // explain and keep chatting until the wallet grants an identity.
      manager.setActive({
        transport,
        client,
        controllerDid: paired.peer?.did ?? 'did:key:zAc2Controller',
        agentDid: 'did:ac2:agent',
        identityGranted: false,
        ...(streamSendable ? { controlTransport: streamSendable } : {}),
        ...(walletAddress !== undefined ? { walletAddress } : {}),
      });
      try {
        await sendChat(NO_IDENTITY_NOTICE);
      } catch (sendErr) {
        context.logger?.error(
          `[ac2-open-claw] failed to send no-identity notice: ${(sendErr as Error).message}`,
        );
      }
    }

    await new Promise<void>((resolve, reject) => {
      transport.onClose(() => resolve());
      transport.onError((err: Error) => reject(err));
      if (streamTransport) {
        streamTransport.onclose = () => resolve();
      }
      context.signal?.addEventListener('abort', () => resolve());
    });
  } finally {
    manager.clearActive();
    if (paired) await paired.close();
  }
}
