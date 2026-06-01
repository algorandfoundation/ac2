import {
    decode,
    isKeyRequest,
    isKeyResponse,
    isSessionClose,
    isSessionEstablish,
    isSigningRejected,
    isSigningRequest,
    isSigningResponse,
    isStreamChunk,
    isStreamEnd,
    isStreamRequest,
} from "../schema/decoder.js";
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
    ValidationResult,
} from "../schema/types.js";

/**
 * Optional handlers for each AC2 message type.
 * Provide only the types you care about; unhandled types are skipped
 * (or routed to `onUnknown` if provided).
 */
export interface MessageHandlers {
    onSigningRequest?: (msg: AC2SigningRequest) => void | Promise<void>;
    onSigningResponse?: (msg: AC2SigningResponse) => void | Promise<void>;
    onSigningRejected?: (msg: AC2SigningRejected) => void | Promise<void>;
    onKeyRequest?: (msg: AC2KeyRequest) => void | Promise<void>;
    onKeyResponse?: (msg: AC2KeyResponse) => void | Promise<void>;
    onSessionEstablish?: (msg: AC2SessionEstablish) => void | Promise<void>;
    onSessionClose?: (msg: AC2SessionClose) => void | Promise<void>;
    onStreamRequest?: (msg: AC2StreamRequest) => void | Promise<void>;
    onStreamChunk?: (msg: AC2StreamChunk) => void | Promise<void>;
    onStreamEnd?: (msg: AC2StreamEnd) => void | Promise<void>;
    onUnknown?: (msg: AC2BaseMessage, validation: ValidationResult) => void | Promise<void>;
}

/**
 * Decode an AC2 message and dispatch it to the matching protocol handler.
 */
export async function handleMessage(
    raw: string | Record<string, unknown>,
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
    else if (isSigningRejected(msg)) await handlers.onSigningRejected?.(msg);
    else if (isKeyRequest(msg)) await handlers.onKeyRequest?.(msg);
    else if (isKeyResponse(msg)) await handlers.onKeyResponse?.(msg);
    else if (isSessionEstablish(msg)) await handlers.onSessionEstablish?.(msg);
    else if (isSessionClose(msg)) await handlers.onSessionClose?.(msg);
    else if (isStreamRequest(msg)) await handlers.onStreamRequest?.(msg);
    else if (isStreamChunk(msg)) await handlers.onStreamChunk?.(msg);
    else if (isStreamEnd(msg)) await handlers.onStreamEnd?.(msg);
    else await handlers.onUnknown?.(msg, validation);

    return validation;
}
