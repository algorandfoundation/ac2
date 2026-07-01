/** Long-running channel runtime: pair via Liquid Auth, then hold the DataChannel open. */

import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { isValidAddress } from '@algorandfoundation/algokit-utils/common';
import type { Ac2ChannelProvider, Ac2PairedChannel } from '@algorandfoundation/ac2-sdk/signaling';
import { LiquidAuthChannelProvider, renderPairingQr } from '../providers/liquid-auth.js';
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
  const provider: Ac2ChannelProvider = deps.provider ?? new LiquidAuthChannelProvider({ origin });
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
        ...(walletAddress !== undefined ? { walletAddress } : {}),
      });
      context.logger?.info('[ac2-open-claw] channel connected; tools are live');
    } catch (err) {
      context.logger?.error(
        `[ac2-open-claw] identity bootstrap failed; signing tools stay disabled: ${(err as Error).message}`,
      );
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
