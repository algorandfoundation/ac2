/** The `ac2` shell + slash command: `pair`, `status`, `connections`, `forget`. */

import qrcode from 'qrcode-terminal';
import { resolveConfig, type OpenClawApi } from '../runtime.js';
import { sessionManager } from '../session/manager.js';
import {
  clearAc2State,
  clearAc2StatePendingRevocation,
  listConnections,
  listConversations,
  loadAc2State,
  withAc2StateLock,
} from '../identity/state.js';
import { clearAgentIdentities, hasAgentIdentity } from '../identity/keystore.js';
import { ensurePersistedPairing, PAIRING_INVITATION_TIMEOUT_MS } from '../identity/pairing.js';
import { revokePairing } from '../providers/liquid-auth.js';

const NODE_MODULE_LOAD_ERROR_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
const ROAMHQ_WRTC_PACKAGE_PATTERN = /@roamhq\/wrtc(?:-[a-z0-9-]+)?/i;

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
        try {
          sessionManager.getActive()?.transport.close();
        } catch {
          // The transport may already be closing.
        }
        sessionManager.clearActive();
        const cfg = resolveConfig(api);
        const origin = cfg.liquidAuthServer ?? 'https://debug.liquidauth.com';
        let pending = false;
        await withAc2StateLock(async () => {
          const pairing = loadAc2State().pairing;
          if (!pairing) {
            clearAc2State();
            return;
          }
          try {
            await revokePairing(origin, pairing, AbortSignal.timeout(5_000));
            clearAc2State();
          } catch {
            pending = true;
            clearAc2StatePendingRevocation(pairing);
          }
        });
        clearAgentIdentities();
        return {
          text: pending
            ? 'Pairing removed locally. Server revocation is pending and will retry automatically.'
            : 'Pairing revoked and local record cleared.',
        };
      }

      if (sub === 'pair') {
        // Pairing is gateway-owned. This command only creates/reads the
        // durable invitation and renders it; it never starts a second,
        // process-local connection loop.
        const durableCfg = resolveConfig(api);
        const durableOrigin = durableCfg.liquidAuthServer ?? 'https://debug.liquidauth.com';
        const durableState = loadAc2State();
        const { pairing: durablePairing } = await ensurePersistedPairing(
          durableOrigin,
          durableState.requestId,
          AbortSignal.timeout(PAIRING_INVITATION_TIMEOUT_MS),
        );
        const durableUrl = `liquid://${durableOrigin.replace(/^https:\/\//, '').replace(/\/$/, '')}/?requestId=${durablePairing.pairingId}`;
        const durableQr = await new Promise<string>((resolve) => {
          qrcode.generate(durableUrl, { small: true }, resolve);
        });
        return {
          text: [
            'AC2 Pairing Invitation',
            '',
            durableQr,
            '',
            `Pairing URL: ${durableUrl}`,
            '',
            'The OpenClaw gateway owns this durable connection. Once paired, future reconnects are automatic.',
          ].join('\n'),
        };
      }

      return { text: `Unknown subcommand: ${sub}. Use 'pair', 'status', or 'forget'.` };
    },
  };
}
