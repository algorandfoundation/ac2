import type {
  AC2BaseMessage,
  AC2KeyRequest,
  AC2KeyResponse,
  AC2SessionClose,
  AC2SessionEstablish,
  AC2SigningRejected,
  AC2SigningRequest,
  AC2SigningResponse,
  AC2StreamChunk,
  AC2StreamEnd,
  AC2StreamRequest,
  KeyRequestBody,
  KeyResponseBody,
  SessionCloseBody,
  SessionEstablishBody,
  SigningRejectedBody,
  SigningRequestBody,
  SigningResponseBody,
  StreamChunkBody,
  StreamEndBody,
  StreamRequestBody,
} from '../schema/types.js';
import { AC2MessageTypes } from '../schema/types.js';

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

export function createSigningRequest(
  envelope: EnvelopeFields,
  body: SigningRequestBody,
): AC2SigningRequest {
  return createBaseMessage(AC2MessageTypes.SIGNING_REQUEST, envelope, body) as AC2SigningRequest;
}

export function createSigningResponse(
  envelope: EnvelopeFields,
  body: SigningResponseBody,
): AC2SigningResponse {
  return createBaseMessage(AC2MessageTypes.SIGNING_RESPONSE, envelope, body) as AC2SigningResponse;
}

export function createSigningRejected(
  envelope: EnvelopeFields,
  body: SigningRejectedBody,
): AC2SigningRejected {
  return createBaseMessage(AC2MessageTypes.SIGNING_REJECTED, envelope, body) as AC2SigningRejected;
}

export function createKeyRequest(envelope: EnvelopeFields, body: KeyRequestBody): AC2KeyRequest {
  return createBaseMessage(AC2MessageTypes.KEY_REQUEST, envelope, body) as AC2KeyRequest;
}

export function createKeyResponse(envelope: EnvelopeFields, body: KeyResponseBody): AC2KeyResponse {
  return createBaseMessage(AC2MessageTypes.KEY_RESPONSE, envelope, body) as AC2KeyResponse;
}

export function createSessionEstablish(
  envelope: EnvelopeFields,
  body: SessionEstablishBody,
): AC2SessionEstablish {
  return createBaseMessage(
    AC2MessageTypes.SESSION_ESTABLISH,
    envelope,
    body,
  ) as AC2SessionEstablish;
}

export function createSessionClose(
  envelope: EnvelopeFields,
  body: SessionCloseBody,
): AC2SessionClose {
  return createBaseMessage(AC2MessageTypes.SESSION_CLOSE, envelope, body) as AC2SessionClose;
}

export function createStreamRequest(
  envelope: EnvelopeFields,
  body: StreamRequestBody,
): AC2StreamRequest {
  return createBaseMessage(AC2MessageTypes.STREAM_REQUEST, envelope, body) as AC2StreamRequest;
}

export function createStreamChunk(envelope: EnvelopeFields, body: StreamChunkBody): AC2StreamChunk {
  return createBaseMessage(AC2MessageTypes.STREAM_CHUNK, envelope, body) as AC2StreamChunk;
}

export function createStreamEnd(envelope: EnvelopeFields, body: StreamEndBody): AC2StreamEnd {
  return createBaseMessage(AC2MessageTypes.STREAM_END, envelope, body) as AC2StreamEnd;
}
