/**
 * Terminal rendering of an AC2 pairing payload.
 *
 * The plugin no longer owns the wallet connection — the AC2 daemon
 * (`@algorandfoundation/ac2-cli`) does — so pairing payloads now arrive as
 * `connection.pairing` control events. This helper is the plain-stdout
 * renderer for embedded/scripted consumers; the `ac2 pair` command renders
 * the same payload into an agent-visible message via `buildInvitationText`.
 */

import qrcode from 'qrcode-terminal';

/** Render a pairing payload to the terminal (QR + raw string). */
export function renderPairingQr(pairing: { qrPayload: string }): void {
  const isTty = typeof process !== 'undefined' && Boolean(process.stdout?.isTTY);
  if (isTty) qrcode.generate(pairing.qrPayload, { small: true });
  // eslint-disable-next-line no-console
  console.log(`[ac2-open-claw] Pair with Controller: ${pairing.qrPayload}`);
}
