/**
 * High-level AC2 client.
 *
 * `Ac2Client` wraps an `Ac2Transport` (the wire-level abstraction) and
 * provides the two normative request/response primitives defined by the
 * AC2 spec — `requestSignature` and `requestKey` — alongside a
 * type-keyed handler map for everything else (unsolicited messages,
 * extension types, telemetry).
 *
 * Both built-in request primitives are *single-use*: the first inbound
 * message whose `thid` and `type` match an in-flight waiter settles it;
 * subsequent matches fall through to the handler map. This matches the
 * spec's normative single-use rules for the Signature Request pattern
 * and `KeyRequest`/`KeyResponse`.
 *
 * Companion builders for the controller / wallet side
 * (`buildSigningResponse`, `buildSigningRejected`, `buildKeyResponse`)
 * live in `protocol/messages.ts` alongside the low-level envelope
 * factories; shared protocol types (`SigningOutcome`, `SigningReply`,
 * `SigningResponder`, etc.) live in `schema/types.ts`.
 */
import { isSigningResponse } from './schema/index.js';
import type {
  AC2BaseMessage,
  AC2KeyRequest,
  AC2KeyResponse,
  AC2SigningRequest,
  AC2SigningResponse,
  AC2SigningRejected,
  BuildKeyRequestArgs,
  BuildSigningRequestArgs,
  KeyResponder,
  SigningOutcome,
  SigningReply,
  SigningResponder,
} from './schema/index.js';
import {
  buildKeyResponse,
  buildSigningRejected,
  buildSigningResponse,
  createKeyRequest,
  createSigningRequest,
  generateMessageId,
} from './protocol/messages.js';
import { defaultMessageHandlers, type MessageHandlerMap } from './protocol/handlers.js';
import type { Ac2Transport } from './transport/index.js';

/**
 * Options accepted by `Ac2Client`. Handlers are a type-keyed map indexed
 * by AC2 message `type` string (see `MessageHandlerMap`). Defaults from
 * `defaultMessageHandlers` are merged in and can be overridden per key.
 */
export interface Ac2ClientOptions {
  /** Type-keyed handlers. Merged on top of `defaultMessageHandlers`. */
  handlers?: MessageHandlerMap;
  /**
   * Fallback for messages whose `type` has no registered handler. If not
   * provided, such messages are silently dropped (after defaults run).
   */
  onUnknown?: (msg: AC2BaseMessage) => void;
  /** Transport or parse errors. */
  onError?: (err: Error) => void;
}

interface Pending {
  responseTypes: Set<string>;
  resolve: (msg: AC2BaseMessage) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * AC2 protocol client.
 *
 * Construct with an `Ac2Transport` (e.g. `rtcDataChannelTransport` or
 * `createInMemoryTransportPair`) and an optional `Ac2ClientOptions`.
 * Inbound messages are dispatched to the type-keyed handler map (merged
 * over `defaultMessageHandlers`); the two single-use request primitives
 * — `requestSignature` and `requestKey` — settle the matching response
 * by `(thid, type)` before the handler map runs.
 *
 * Lifecycle: closing the underlying transport rejects all in-flight
 * waiters with a `Transport closed` error. `close()` is idempotent.
 */
export class Ac2Client {
  private readonly transport: Ac2Transport;
  private handlers: MessageHandlerMap;
  private onUnknown?: (msg: AC2BaseMessage) => void;
  private onError?: (err: Error) => void;
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(transport: Ac2Transport, options: Ac2ClientOptions = {}) {
    this.transport = transport;
    this.handlers = { ...defaultMessageHandlers, ...options.handlers };
    if (options.onUnknown !== undefined) this.onUnknown = options.onUnknown;
    if (options.onError !== undefined) this.onError = options.onError;

    transport.onMessage((msg) => this.dispatch(msg));
    transport.onError((err) => this.onError?.(err));
    transport.onClose(() => {
      this.closed = true;
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error('[ac2-sdk] Transport closed'));
      }
      this.pending.clear();
    });
  }

  /**
   * Replace all handlers. Missing keys fall back to `defaultMessageHandlers`.
   * Use this when a screen / consumer wants to fully own the handler set.
   */
  setHandlers(handlers: MessageHandlerMap): void {
    this.handlers = { ...defaultMessageHandlers, ...handlers };
  }

  /**
   * Shallow-merge a patch into the current handler map. Useful for
   * plugins or screens that want to register handlers for a subset of
   * message `type`s (including brand-new extension types) without
   * touching the others. Last writer wins per key.
   */
  updateHandlers(patch: MessageHandlerMap): void {
    this.handlers = { ...this.handlers, ...patch };
  }

  /**
   * Send an AC2 message as-is.
   *
   * Use this for fire-and-forget traffic that does not follow the
   * request/response pattern — unsolicited notifications, the
   * controller-side response/rejected messages, and any extension
   * message types your application defines.
   *
   * Throws if the client has been closed.
   */
  send(message: AC2BaseMessage): void {
    if (this.closed) throw new Error('[ac2-sdk] Client is closed');
    this.transport.send(JSON.stringify(message));
  }

  /**
   * Build, send, and await the outcome of a signing request. Resolves with
   * the matched `SigningResponse` or `SigningRejected` (paired by `thid`).
   * Rejects on timeout or transport close.
   *
   * Thin wrapper over `awaitThreadResponse` — single-use enforcement is
   * provided by the underlying primitive.
   */
  async requestSignature(
    args: BuildSigningRequestArgs,
    opts: { timeoutMs?: number } = {},
  ): Promise<SigningOutcome> {
    const message = createSigningRequest(this.buildRequestEnvelope(args), args.body);
    const waitOpts: { responseTypes: readonly string[]; timeoutMs?: number } = {
      responseTypes: ['ac2/SigningResponse', 'ac2/SigningRejected'],
    };
    if (opts.timeoutMs !== undefined) waitOpts.timeoutMs = opts.timeoutMs;
    const reply = await this.awaitThreadResponse<AC2SigningResponse | AC2SigningRejected>(
      message,
      waitOpts,
    );
    return isSigningResponse(reply)
      ? { kind: 'response', message: reply }
      : { kind: 'rejected', message: reply };
  }

  /**
   * Build, send, and await a `KeyResponse` for an HD-derived key request.
   *
   * `KeyResponse.body.status` carries the `approved | rejected` distinction
   * (see SPEC.md → "AC2 KeyRequest / KeyResponse"), so this resolves with
   * the raw response regardless of outcome; callers branch on `body.status`.
   * Single-use semantics match the spec ("A `KeyResponse` delivers the
   * derived key exactly once").
   */
  async requestKey(
    args: BuildKeyRequestArgs,
    opts: { timeoutMs?: number } = {},
  ): Promise<AC2KeyResponse> {
    const message = createKeyRequest(this.buildRequestEnvelope(args), args.body);
    const waitOpts: { responseTypes: readonly string[]; timeoutMs?: number } = {
      responseTypes: ['ac2/KeyResponse'],
    };
    if (opts.timeoutMs !== undefined) waitOpts.timeoutMs = opts.timeoutMs;
    return this.awaitThreadResponse<AC2KeyResponse>(message, waitOpts);
  }

  /**
   * Register a responder for inbound `ac2/SigningRequest` messages —
   * the controller / wallet side of the Signature Request pattern.
   *
   * The supplied function inspects the request (typically prompting the
   * user) and returns either an approval carrying the produced
   * signature, or a rejection carrying a human-readable reason. The SDK
   * builds the matching `ac2/SigningResponse` or `ac2/SigningRejected`
   * envelope (threading `thid` and addressing `to`/`from` automatically
   * via `buildSigningResponse` / `buildSigningRejected`) and sends it on
   * the underlying transport.
   *
   * Pure ergonomic sugar over `updateHandlers({ 'ac2/SigningRequest': ... })`
   * plus `send(buildSigningResponse(...))`. The agent-side counterpart is
   * `requestSignature`; together they make the request/response surface
   * visibly symmetric.
   *
   * Last writer wins — calling this again replaces the previous
   * responder. Throwing (or rejecting) from `fn` reports the error via
   * `onError` and sends no reply.
   */
  onSigningRequest(fn: SigningResponder): void {
    this.updateHandlers({
      'ac2/SigningRequest': async (msg) => {
        const request = msg as AC2SigningRequest;
        let reply: SigningReply;
        try {
          reply = await fn(request);
        } catch (err) {
          this.reportError(err);
          return;
        }
        try {
          const out =
            reply.kind === 'approve'
              ? buildSigningResponse({ request, body: reply.body })
              : buildSigningRejected({ request, reason: reply.reason });
          this.send(out);
        } catch (err) {
          this.reportError(err);
        }
      },
    });
  }

  /**
   * Register a responder for inbound `ac2/KeyRequest` messages — the
   * controller / wallet (keystore-holder) side of the
   * `KeyRequest`/`KeyResponse` pattern.
   *
   * The supplied function returns an `ac2/KeyResponse` body — either
   * `{ status: 'approved', material: ... }` on success or
   * `{ status: 'rejected', reason: ... }` on refusal. The SDK assembles
   * and sends the matching envelope via `buildKeyResponse`.
   *
   * Pure ergonomic sugar over `updateHandlers({ 'ac2/KeyRequest': ... })`.
   * The agent-side counterpart is `requestKey`.
   *
   * Last writer wins. Throwing (or rejecting) from `fn` reports the
   * error via `onError` and sends no reply.
   */
  onKeyRequest(fn: KeyResponder): void {
    this.updateHandlers({
      'ac2/KeyRequest': async (msg) => {
        const request = msg as AC2KeyRequest;
        let body: AC2KeyResponse['body'];
        try {
          body = await fn(request);
        } catch (err) {
          this.reportError(err);
          return;
        }
        try {
          this.send(buildKeyResponse({ request, body }));
        } catch (err) {
          this.reportError(err);
        }
      },
    });
  }

  /**
   * Close the client and its underlying transport. Idempotent; safe to
   * call multiple times. Pending request waiters are rejected by the
   * transport's `onClose` hook.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  /**
   * Generic single-use control-plane primitive. Send `message`, then
   * settle on the first inbound message whose `thid === message.id` AND
   * whose `type` is one of `responseTypes`.
   *
   * Single-use is the only mode because it is the only pairing rule the
   * AC2 spec gives us today — it appears in both the Signature Request
   * pattern ("bound to this specific request; single-use") and the
   * `KeyRequest`/`KeyResponse` section ("delivers the derived key
   * exactly once"). Streaming, when it lands as an extension, will need
   * a separate primitive (a side-channel handle), not a `mode` on this
   * one.
   */
  private awaitThreadResponse<TRes extends AC2BaseMessage>(
    message: AC2BaseMessage,
    opts: { responseTypes: readonly string[]; timeoutMs?: number },
  ): Promise<TRes> {
    this.send(message);
    return new Promise<TRes>((resolve, reject) => {
      const pending: Pending = {
        responseTypes: new Set(opts.responseTypes),
        resolve: resolve as (msg: AC2BaseMessage) => void,
        reject,
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(message.id);
          reject(
            new Error(`[ac2-sdk] Request "${message.id}" timed out after ${opts.timeoutMs}ms`),
          );
        }, opts.timeoutMs);
      }
      this.pending.set(message.id, pending);
    });
  }

  private buildRequestEnvelope(args: BuildSigningRequestArgs | BuildKeyRequestArgs): {
    id: string;
    from: string;
    to: string[];
    created_time: number;
    expires_time?: number;
  } {
    const envelope: {
      id: string;
      from: string;
      to: string[];
      created_time: number;
      expires_time?: number;
    } = {
      id: args.id ?? generateMessageId(),
      from: args.from,
      to: Array.isArray(args.to) ? [...args.to] : [args.to as string],
      created_time: args.created_time ?? Math.floor(Date.now() / 1000),
    };
    if (args.expires_time !== undefined) envelope.expires_time = args.expires_time;
    return envelope;
  }

  private reportError(err: unknown): void {
    this.onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  private dispatch(msg: AC2BaseMessage): void {
    // Control-plane correlation: if this message carries a `thid` matching
    // an in-flight single-use waiter AND its `type` is one the waiter
    // registered for, settle the waiter and stop. This is checked BEFORE
    // the type-keyed handler map so a consumer's handler (or the default)
    // can't shadow promise resolution.
    //
    // Single-use is anchored in two SPEC.md sections:
    //   - Signature Request pattern ("bound to this specific request;
    //     single-use")
    //   - AC2 KeyRequest / KeyResponse ("delivers the derived key exactly
    //     once").
    // It is a property of these *patterns*, not of `thid` itself —
    // future extensions (e.g. streaming child threads) may keep a thread
    // open across many messages and should not reuse this primitive.
    const thid = msg.thid;
    if (thid) {
      const pending = this.pending.get(thid);
      if (pending && pending.responseTypes.has(msg.type)) {
        this.pending.delete(thid);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(msg);
        return;
      }
    }

    const fn = this.handlers[msg.type];
    if (fn) {
      void fn(msg, { valid: true, errors: [], warnings: [] });
      return;
    }
    this.onUnknown?.(msg);
  }
}
