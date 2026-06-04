import { decode } from '../schema/decoder.js';
import type {
  AC2BaseMessage,
  AC2KeyRequest,
  AC2KeyResponse,
  AC2SigningRequest,
  AC2SigningResponse,
  AC2SigningRejected,
  ValidationResult,
} from '../schema/types.js';

/**
 * A single handler keyed by an AC2 message `type` string.
 *
 * The dispatcher (`handleMessage`) selects the handler purely by
 * `msg.type`, so downstream packages can register handlers for
 * extension message types the SDK does not natively know about.
 */
export type MessageHandler<T extends AC2BaseMessage = AC2BaseMessage> = (
  msg: T,
  validation: ValidationResult,
) => void | Promise<void>;

/**
 * Type-keyed map of handlers.
 *
 * Built-in message types are declared with precise per-key types so
 * `handlers['ac2/SigningRequest']` is inferred as
 * `MessageHandler<AC2SigningRequest>`. The index signature keeps the map
 * open: consumers may register handlers for any extension `type` string
 * (e.g. `'com.acme.payment.request'`) without forking the SDK.
 *
 * Downstream packages can sharpen the typing of their extension keys via
 * declaration merging:
 *
 * ```ts
 * declare module '@algorandfoundation/ac2-sdk/protocol' {
 *   interface MessageHandlerMap {
 *     'com.acme.payment.request'?: MessageHandler<AC2PaymentRequest>;
 *   }
 * }
 * ```
 */
export interface MessageHandlerMap {
  'ac2/SigningRequest'?: MessageHandler<AC2SigningRequest>;
  'ac2/SigningResponse'?: MessageHandler<AC2SigningResponse>;
  'ac2/SigningRejected'?: MessageHandler<AC2SigningRejected>;
  'ac2/KeyRequest'?: MessageHandler<AC2KeyRequest>;
  'ac2/KeyResponse'?: MessageHandler<AC2KeyResponse>;
  /**
   * Open-ended: any extension message type. Typed as `MessageHandler<any>`
   * so that precisely-typed built-in keys (e.g. `MessageHandler<AC2SigningRequest>`)
   * remain assignable through the index signature.
   */
  [type: string]: MessageHandler<any> | undefined;
}

/**
 * Dispatch options paired with a `MessageHandlerMap`.
 */
export interface MessageHandlers {
  /** Type-keyed handlers. */
  handlers?: MessageHandlerMap;
  /**
   * Fallback called when:
   *   - the payload fails validation, or
   *   - no handler is registered for the message `type`.
   */
  onUnknown?: (msg: AC2BaseMessage, validation: ValidationResult) => void | Promise<void>;
}

/**
 * Default handlers shipped with the SDK. They simply log; consumers
 * override them by passing their own entries into the map (last spread
 * wins).
 */
export const defaultMessageHandlers: MessageHandlerMap = {
  'ac2/SigningRequest': (msg) => {
    console.warn(
      `[ac2-sdk] Unhandled SigningRequest from ${msg.from} (id=${msg.id}). ` +
        `Register a handler for "ac2/SigningRequest" to respond.`,
    );
  },
  'ac2/SigningResponse': (msg) => {
    console.warn(`[ac2-sdk] Unhandled SigningResponse (id=${msg.id}).`);
  },
  'ac2/SigningRejected': (msg) => {
    console.warn(`[ac2-sdk] Unhandled SigningRejected (id=${msg.id}).`);
  },
  'ac2/KeyRequest': (msg) => {
    console.warn(`[ac2-sdk] Unhandled KeyRequest (id=${msg.id}).`);
  },
  'ac2/KeyResponse': (msg) => {
    console.warn(`[ac2-sdk] Unhandled KeyResponse (id=${msg.id}).`);
  },
};

/**
 * Decode an AC2 message and dispatch it to the matching protocol handler
 * via a single `type`-string lookup. Unknown / unregistered types fall
 * through to `onUnknown` if provided.
 */
export async function handleMessage(
  raw: string | AC2BaseMessage | Record<string, unknown>,
  handlers: MessageHandlers,
): Promise<ValidationResult> {
  const { message, validation } = decode(raw);
  const msg = message as AC2BaseMessage;

  if (!validation.valid) {
    await handlers.onUnknown?.(msg, validation);
    return validation;
  }

  const fn = handlers.handlers?.[msg.type];
  if (fn) await fn(msg, validation);
  else await handlers.onUnknown?.(msg, validation);

  return validation;
}
