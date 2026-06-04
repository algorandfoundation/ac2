/**
 * Low-level constructors for the five built-in AC2 message types.
 *
 * These factories assemble a DIDComm v2 envelope around a typed body and
 * stamp the spec-mandated `type` URI. They perform no validation — pass
 * the result through `validate` (from `@algorandfoundation/ac2-sdk/schema`)
 * if you need to confirm a freshly-constructed message conforms to the
 * registered body schema.
 *
 * Most consumers will reach for the higher-level `Ac2Client.requestSignature`
 * / `requestKey` / `buildSigningResponse` / `buildSigningRejected` /
 * `buildKeyResponse` helpers instead; these factories are exported for
 * direct use when callers want full control over the envelope.
 */
import type {
  AC2BaseMessage,
  AC2KeyRequest,
  AC2KeyResponse,
  AC2SigningRequest,
  AC2SigningResponse,
  AC2SigningRejected,
  BuildKeyResponseArgs,
  BuildSigningRejectedArgs,
  BuildSigningResponseArgs,
  KeyRequestBody,
  KeyResponseBody,
  SigningRejectedBody,
  SigningRequestBody,
  SigningResponseBody,
} from '../schema/types.js';
import { AC2MessageTypes } from '../schema/types.js';

/**
 * Generate a UUIDv4-shaped message id. Uses `crypto.randomUUID` when
 * available, falls back to `getRandomValues`, and finally to a non-secure
 * `Math.random` shim. Exported for use by higher-level helpers.
 */
export function generateMessageId(): string {
  const g = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  if (g.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    g.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b: any) => b.toString(16).padStart(2, '0'));
    return (
      `${hex.slice(0, 4).join('')}-` +
      `${hex.slice(4, 6).join('')}-` +
      `${hex.slice(6, 8).join('')}-` +
      `${hex.slice(8, 10).join('')}-` +
      `${hex.slice(10, 16).join('')}`
    );
  }
  return Math.random().toString(36).substring(2, 15);
}

type EnvelopeFields = Pick<
  AC2BaseMessage,
  'id' | 'from' | 'to' | 'created_time' | 'expires_time' | 'thid' | 'pthid' | 'attachments'
>;

function createBaseMessage<TBody extends object>(
  type: string,
  envelope: EnvelopeFields,
  body: TBody,
): AC2BaseMessage {
  const message: AC2BaseMessage = {
    id: envelope.id,
    type,
    from: envelope.from,
    to: envelope.to,
    created_time: envelope.created_time,
    body,
  };

  if (envelope.expires_time !== undefined) message.expires_time = envelope.expires_time;
  if (envelope.thid !== undefined) message.thid = envelope.thid;
  if (envelope.pthid !== undefined) message.pthid = envelope.pthid;
  if (envelope.attachments !== undefined) message.attachments = envelope.attachments;

  return message;
}

/**
 * Construct an `ac2/SigningRequest` (agent → controller).
 *
 * The caller supplies a fully-populated DIDComm envelope (`id`, `from`,
 * `to`, `created_time`, and optionally `expires_time` / `thid` / `pthid` /
 * `attachments`). For request/response correlation prefer
 * `Ac2Client.requestSignature`, which assembles the envelope and threads
 * the matching response back to the caller.
 */
export function createSigningRequest(
  envelope: EnvelopeFields,
  body: SigningRequestBody,
): AC2SigningRequest {
  return createBaseMessage(AC2MessageTypes.SIGNING_REQUEST, envelope, body) as AC2SigningRequest;
}

/**
 * Construct an `ac2/SigningResponse` (controller → agent).
 *
 * The envelope's `thid` MUST be the `id` of the originating
 * `SigningRequest`. Prefer the higher-level `buildSigningResponse`
 * helper, which derives `thid`, `to`, and `from` from the request.
 */
export function createSigningResponse(
  envelope: EnvelopeFields,
  body: SigningResponseBody,
): AC2SigningResponse {
  return createBaseMessage(AC2MessageTypes.SIGNING_RESPONSE, envelope, body) as AC2SigningResponse;
}

/**
 * Construct an `ac2/SigningRejected` (controller → agent) carrying the
 * user-supplied rejection `reason`. Like `createSigningResponse`,
 * `envelope.thid` MUST point at the originating request. Prefer
 * `buildSigningRejected` when you have the request in hand.
 */
export function createSigningRejected(
  envelope: EnvelopeFields,
  body: SigningRejectedBody,
): AC2SigningRejected {
  return createBaseMessage(AC2MessageTypes.SIGNING_REJECTED, envelope, body) as AC2SigningRejected;
}

/**
 * Construct an `ac2/KeyRequest` (agent → controller) asking the
 * controller to derive and return a key. Prefer `Ac2Client.requestKey`
 * for the request/response flow.
 */
export function createKeyRequest(envelope: EnvelopeFields, body: KeyRequestBody): AC2KeyRequest {
  return createBaseMessage(AC2MessageTypes.KEY_REQUEST, envelope, body) as AC2KeyRequest;
}

/**
 * Construct an `ac2/KeyResponse` (controller → agent). The body's
 * `status` field carries the approve/reject distinction (per the spec's
 * single-message KeyResponse shape). `envelope.thid` MUST point at the
 * originating `KeyRequest`; prefer `buildKeyResponse` when responding to
 * a request you already hold.
 */
export function createKeyResponse(envelope: EnvelopeFields, body: KeyResponseBody): AC2KeyResponse {
  return createBaseMessage(AC2MessageTypes.KEY_RESPONSE, envelope, body) as AC2KeyResponse;
}

// ─── High-level Reply Builders ────────────────────────────────────────────────
//
// `buildSigningResponse` / `buildSigningRejected` / `buildKeyResponse` are
// the controller-side counterparts to `Ac2Client.requestSignature` /
// `requestKey`. They derive `thid`, `from`, and `to` from the request being
// answered so callers do not have to assemble envelopes by hand.

function inferReplyFrom<TReq extends { to: readonly string[] }>(
  args: { request: TReq; from?: string },
  label: string,
): string {
  const from = args.from ?? args.request.to[0];
  if (!from) {
    throw new Error(`[ac2-sdk] ${label}.from could not be inferred; pass \`from\` explicitly.`);
  }
  return from;
}

function buildReplyEnvelope(args: {
  request: { id: string; from: string };
  from: string;
  id?: string;
  created_time?: number;
  expires_time?: number;
}): EnvelopeFields {
  const envelope: EnvelopeFields = {
    id: args.id ?? generateMessageId(),
    from: args.from,
    to: [args.request.from],
    created_time: args.created_time ?? Math.floor(Date.now() / 1000),
    thid: args.request.id,
  };
  if (args.expires_time !== undefined) envelope.expires_time = args.expires_time;
  return envelope;
}

/**
 * Build an `ac2/SigningResponse` addressed to the originator of
 * `args.request`. `thid` is set to `request.id` and `to` is set to
 * `[request.from]`; `from` is inferred from `request.to[0]` unless
 * explicitly supplied.
 *
 * Throws if `from` cannot be inferred (i.e. `request.to` is empty and
 * no `from` was passed).
 */
export function buildSigningResponse(args: BuildSigningResponseArgs): AC2SigningResponse {
  const from = inferReplyFrom(args, 'SigningResponse');
  const envelope = buildReplyEnvelope({
    request: args.request,
    from,
    ...(args.id !== undefined ? { id: args.id } : {}),
    ...(args.created_time !== undefined ? { created_time: args.created_time } : {}),
    ...(args.expires_time !== undefined ? { expires_time: args.expires_time } : {}),
  });
  return createSigningResponse(envelope, args.body);
}

/**
 * Build an `ac2/SigningRejected` for the supplied request. See
 * `buildSigningResponse` for the addressing / threading rules — they
 * are identical.
 */
export function buildSigningRejected(args: BuildSigningRejectedArgs): AC2SigningRejected {
  const from = inferReplyFrom(args, 'SigningRejected');
  const envelope = buildReplyEnvelope({
    request: args.request,
    from,
    ...(args.id !== undefined ? { id: args.id } : {}),
    ...(args.created_time !== undefined ? { created_time: args.created_time } : {}),
    ...(args.expires_time !== undefined ? { expires_time: args.expires_time } : {}),
  });
  return createSigningRejected(envelope, { reason: args.reason });
}

/**
 * Build an `ac2/KeyResponse` for the supplied request. `body.status`
 * carries the approve/reject distinction; on rejection set
 * `body.status = 'rejected'` and populate `body.reason`.
 */
export function buildKeyResponse(args: BuildKeyResponseArgs): AC2KeyResponse {
  const from = inferReplyFrom(args, 'KeyResponse');
  const envelope = buildReplyEnvelope({
    request: args.request,
    from,
    ...(args.id !== undefined ? { id: args.id } : {}),
    ...(args.created_time !== undefined ? { created_time: args.created_time } : {}),
    ...(args.expires_time !== undefined ? { expires_time: args.expires_time } : {}),
  });
  return createKeyResponse(envelope, args.body);
}
