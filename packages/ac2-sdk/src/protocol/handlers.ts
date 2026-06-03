import {
  decode,
  isKeyRequest,
  isKeyResponse,
  isSigningRequest,
  isSigningResponse,
} from '../schema/decoder.js';
import type {
  AC2BaseMessage,
  AC2KeyRequest,
  AC2KeyResponse,
  AC2SigningRequest,
  AC2SigningResponse,
  ValidationResult,
} from '../schema/types.js';

/**
 * Optional handlers for each AC2 message type.
 * Provide only the types you care about; unhandled types are skipped
 * (or routed to `onUnknown` if provided).
 */
export interface MessageHandlers {
  onSigningRequest?: (msg: AC2SigningRequest) => void | Promise<void>;
  onSigningResponse?: (msg: AC2SigningResponse) => void | Promise<void>;
  onKeyRequest?: (msg: AC2KeyRequest) => void | Promise<void>;
  onKeyResponse?: (msg: AC2KeyResponse) => void | Promise<void>;
  onUnknown?: (msg: AC2BaseMessage, validation: ValidationResult) => void | Promise<void>;
}

/**
 * Decode an AC2 message and dispatch it to the matching protocol handler.
 */
export async function handleMessage(
  raw: string | AC2BaseMessage | Record<string, unknown>,
  handlers: MessageHandlers,
): Promise<ValidationResult> {
  const { message, validation } = decode(raw);

  if (!validation.valid) {
    await handlers.onUnknown?.(message, validation);
    return validation;
  }

  const msg = message as AC2BaseMessage;

  if (isSigningRequest(msg)) await handlers.onSigningRequest?.(msg);
  else if (isSigningResponse(msg)) await handlers.onSigningResponse?.(msg);
  else if (isKeyRequest(msg)) await handlers.onKeyRequest?.(msg);
  else if (isKeyResponse(msg)) await handlers.onKeyResponse?.(msg);
  else await handlers.onUnknown?.(msg, validation);

  return validation;
}
