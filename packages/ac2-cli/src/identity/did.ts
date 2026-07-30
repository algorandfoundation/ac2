/**
 * `did:key:z…` normalization for the same Ed25519 key arriving in base58btc,
 * Algorand base32, or base64.
 *
 * The normalization itself has no CLI/state dependencies, so it now lives in
 * `@algorandfoundation/ac2-sdk/signaling` (alongside `Ac2PairedChannel.peer.did`,
 * which is exactly where a channel provider surfaces it). Re-exported here so
 * existing CLI consumers of `../identity/did.js` are unaffected by the move.
 */
export {
  extractEd25519PublicKey,
  normalizeDidKey,
  publicKeyToDidKey,
} from '@algorandfoundation/ac2-sdk/signaling';

/**
 * Resolve the canonical controller DID used to key the agent's session
 * (`ac2:<controllerDid>:<thid>`), keeping it byte-identical across reconnects.
 *
 * The OpenClaw runtime persists each agent conversation on disk keyed by that
 * session key, so the agent only "remembers" a thread when the key resolves to
 * the same value on every (re)connect. A granted identity is therefore the
 * anchor: its `controllerDid` was bound (and verified against the linked
 * account) to this connection when the identity was granted, so we reuse it
 * verbatim. Only when no identity has been granted yet do we fall back to the
 * DID derived from the live link, then to the placeholder.
 *
 * Without this anchor a presence-only reconnect — which renegotiates the
 * WebRTC session without a fresh Liquid Auth `link`, and so often omits the
 * wallet address — would re-derive `controllerDid` from a differently-encoded
 * peer DID, rotate the session key, and make the agent load a fresh, empty
 * session (i.e. lose the thread's context).
 */
export function resolveStableControllerDid(params: {
  storedControllerDid?: string | undefined;
  connectedAccountDid?: string | undefined;
  placeholder?: string | undefined;
}): string {
  return (
    params.storedControllerDid ??
    params.connectedAccountDid ??
    params.placeholder ??
    'did:key:zAc2Controller'
  );
}
