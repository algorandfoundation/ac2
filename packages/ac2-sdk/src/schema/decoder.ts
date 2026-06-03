import type {
  AC2BaseMessage,
  AC2KeyRequest,
  AC2KeyResponse,
  AC2Message,
  AC2SessionClose,
  AC2SessionEstablish,
  AC2SigningRejected,
  AC2SigningRequest,
  AC2SigningResponse,
  AC2StreamChunk,
  AC2StreamEnd,
  AC2StreamRequest,
  DecodeResult,
  ValidationResult,
} from './types.js';
import { AC2MessageTypes } from './types.js';
import { validate } from './validator.js';

// ─── Decode ───────────────────────────────────────────────────────────────────

/**
 * Parse and validate an AC2 message from a raw JSON string or plain object.
 *
 * Returns both the (loosely-typed) message and its validation result.
 * Use the exported type guards (`isSigningRequest`, etc.) to narrow the type.
 *
 * @example
 * const { message, validation } = decode(rawJson);
 * if (validation.valid && isSigningRequest(message)) {
 *   console.log(message.body.operation);
 * }
 */
export function decode(raw: string | Record<string, unknown>): DecodeResult {
  let obj: unknown;

  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      const validation: ValidationResult = {
        valid: false,
        errors: ['Invalid JSON: failed to parse'],
        warnings: [],
      };
      return { message: {} as AC2Message, validation };
    }
  } else {
    obj = raw;
  }

  const validation = validate(obj);
  return { message: obj as AC2Message, validation };
}

// ─── Type Guards ──────────────────────────────────────────────────────────────

export function isSigningRequest(msg: AC2BaseMessage): msg is AC2SigningRequest {
  return msg.type === AC2MessageTypes.SIGNING_REQUEST;
}

export function isSigningResponse(msg: AC2BaseMessage): msg is AC2SigningResponse {
  return msg.type === AC2MessageTypes.SIGNING_RESPONSE;
}

export function isSigningRejected(msg: AC2BaseMessage): msg is AC2SigningRejected {
  return msg.type === AC2MessageTypes.SIGNING_REJECTED;
}

export function isKeyRequest(msg: AC2BaseMessage): msg is AC2KeyRequest {
  return msg.type === AC2MessageTypes.KEY_REQUEST;
}

export function isKeyResponse(msg: AC2BaseMessage): msg is AC2KeyResponse {
  return msg.type === AC2MessageTypes.KEY_RESPONSE;
}

export function isSessionEstablish(msg: AC2BaseMessage): msg is AC2SessionEstablish {
  return msg.type === AC2MessageTypes.SESSION_ESTABLISH;
}

export function isSessionClose(msg: AC2BaseMessage): msg is AC2SessionClose {
  return msg.type === AC2MessageTypes.SESSION_CLOSE;
}

export function isStreamRequest(msg: AC2BaseMessage): msg is AC2StreamRequest {
  return msg.type === AC2MessageTypes.STREAM_REQUEST;
}

export function isStreamChunk(msg: AC2BaseMessage): msg is AC2StreamChunk {
  return msg.type === AC2MessageTypes.STREAM_CHUNK;
}

export function isStreamEnd(msg: AC2BaseMessage): msg is AC2StreamEnd {
  return msg.type === AC2MessageTypes.STREAM_END;
}
