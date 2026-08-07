/**
 * A fully in-process fake {@link GatewayConnection} (see
 * `src/runtime/gateway/connection.ts`), so `client.ts` and `adapter.ts` can
 * be exercised without ever opening a real WebSocket — no gateway server
 * dependency anywhere in the test suite.
 *
 * Parses every outbound frame (JSON) so tests can assert on structured
 * request objects instead of raw strings, and exposes `respondOk`/
 * `respondError`/`emitEvent` helpers that simulate the Gateway's side of
 * the wire.
 */

import type { GatewayConnection } from '../../src/runtime/gateway/connection.js';
import type { GatewayRpcErrorPayload } from '../../src/runtime/gateway/client.js';

interface ParsedRequestFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

export class FakeGatewayConnection implements GatewayConnection {
  /** Every outbound frame, parsed, in send order. */
  readonly sent: ParsedRequestFrame[] = [];
  /** Raw outbound strings, in send order (for anything not a `req` frame). */
  readonly sentRaw: string[] = [];
  closed = false;

  private readonly messageHandlers: Array<(data: string) => void> = [];
  private readonly closeHandlers: Array<(reason: string) => void> = [];
  private readonly openHandlers: Array<() => void> = [];
  private readonly respondedIds = new Set<string>();

  send(data: string): void {
    this.sentRaw.push(data);
    try {
      const parsed: unknown = JSON.parse(data);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as Record<string, unknown>)['type'] === 'req'
      ) {
        this.sent.push(parsed as ParsedRequestFrame);
      }
    } catch {
      // non-JSON frames are recorded only in `sentRaw`.
    }
  }

  close(): void {
    this.closed = true;
  }

  onMessage(cb: (data: string) => void): void {
    this.messageHandlers.push(cb);
  }

  onClose(cb: (reason: string) => void): void {
    this.closeHandlers.push(cb);
  }

  onOpen(cb: () => void): void {
    this.openHandlers.push(cb);
  }

  /** Simulate the socket opening (fires every registered `onOpen` handler). */
  triggerOpen(): void {
    for (const handler of [...this.openHandlers]) handler();
  }

  /** Simulate the socket closing (fires every registered `onClose` handler). */
  triggerClose(reason = 'test-close'): void {
    for (const handler of [...this.closeHandlers]) handler(reason);
  }

  /** Feed a raw inbound frame to every registered `onMessage` handler. */
  emitRaw(data: string): void {
    for (const handler of [...this.messageHandlers]) handler(data);
  }

  /** Feed a parsed inbound frame (JSON-stringified for you). */
  emitFrame(frame: Record<string, unknown>): void {
    this.emitRaw(JSON.stringify(frame));
  }

  /**
   * Simulate a successful handshake EXACTLY as a live Gateway does (confirmed
   * against server 2026.7.1-x, protocol v4): a `connect.challenge` event
   * first, then `hello-ok` delivered as the PAYLOAD of the `res` correlated
   * to the `connect` request — the Gateway does NOT send a top-level
   * `hello-ok` frame. Requires the client to have already sent its `connect`
   * request (call {@link triggerOpen} first).
   *
   * The challenge comes FIRST because a client that signs a device identity
   * can only assemble its `connect` once it has the nonce — and, since that
   * signature goes through the keystore, only ASYNCHRONOUSLY. Hence this
   * awaits the `connect` frame before answering it.
   *
   * @param auth optional `hello-ok.auth` block (granted `scopes`, issued
   *   `deviceToken`); omitted entirely by default, which is how a server that
   *   does not report grants behaves.
   */
  async emitHelloOk(auth?: { role?: string; scopes?: string[]; deviceToken?: string }): Promise<void> {
    this.emitEvent('connect.challenge', { nonce: 'test-nonce', ts: Date.now() });
    await waitFor(() => this.findPendingRequest('connect') !== undefined);
    this.respondOk('connect', {
      type: 'hello-ok',
      protocol: 4,
      server: { version: 'test', connId: 'conn-1' },
      features: { methods: [], events: [] },
      ...(auth ? { auth } : {}),
    });
  }

  /** The most recent not-yet-responded-to sent request for `method`, if any. */
  private findPendingRequest(method: string): ParsedRequestFrame | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const candidate = this.sent[i];
      if (candidate && candidate.method === method && !this.respondedIds.has(candidate.id)) {
        return candidate;
      }
    }
    return undefined;
  }

  /** Respond `ok: true` to the oldest-not-yet-answered request for `method`. */
  respondOk(method: string, payload?: unknown): void {
    const req = this.findPendingRequest(method);
    if (!req) throw new Error(`FakeGatewayConnection: no pending request for method "${method}"`);
    this.respondedIds.add(req.id);
    this.emitFrame({ type: 'res', id: req.id, ok: true, ...(payload !== undefined ? { payload } : {}) });
  }

  /** Respond `ok: false` to the oldest-not-yet-answered request for `method`. */
  respondError(method: string, error: GatewayRpcErrorPayload): void {
    const req = this.findPendingRequest(method);
    if (!req) throw new Error(`FakeGatewayConnection: no pending request for method "${method}"`);
    this.respondedIds.add(req.id);
    this.emitFrame({ type: 'res', id: req.id, ok: false, error });
  }

  /** Push a Gateway `event` frame. */
  emitEvent(event: string, payload?: unknown): void {
    this.emitFrame({ type: 'event', event, ...(payload !== undefined ? { payload } : {}) });
  }
}

/** Poll until `predicate` holds (or fail after `timeoutMs`). */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
