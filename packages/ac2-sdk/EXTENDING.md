# Extending `@algorandfoundation/ac2-sdk`

This guide covers the SDK's extension surface: subpath layout, custom transports, custom message types, and signaling providers.

## Package layout

The SDK exposes one top-level entry and four subpaths, each importable independently.

| Import                                  | What you get                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@algorandfoundation/ac2-sdk`           | Namespace barrel re-exporting `schema`, `protocol`, `transport`, `signaling`, plus `Ac2Client` / `Ac2ClientOptions` |
| `@algorandfoundation/ac2-sdk/schema`    | Pure types, type guards, decoding, JSON-schema validation                                                           |
| `@algorandfoundation/ac2-sdk/protocol`  | `Ac2Client`, low-level message factories (`createSigningRequest`, ...), reply builders, type-keyed `handleMessage`  |
| `@algorandfoundation/ac2-sdk/transport` | `Ac2Transport` interface plus `rtcDataChannelTransport` and `createInMemoryTransportPair`                           |
| `@algorandfoundation/ac2-sdk/signaling` | `Ac2ChannelProvider` interface for bringup adapters (Liquid Auth, DIDCommRTC, ...)                                  |

ESM consumers should prefer the subpaths (better tree-shaking). CJS consumers can reach every symbol through the namespace barrel:

```ts
import * as ac2 from '@algorandfoundation/ac2-sdk';
const transport = ac2.transport.rtcDataChannelTransport(dataChannel);
const client = new ac2.Ac2Client(transport);
```

## `Ac2Client` internals

`Ac2Client` wraps an `Ac2Transport` and exposes both sides of every AC2 request/response pair. Built-in pairs are single-use (one request, one matching response) with `thid`-based correlation.

Requester (agent) primitives:

- `requestSignature(args, { timeoutMs })` sends a `SigningRequest` and resolves to a discriminated `SigningOutcome` (`{ kind: 'response', ... }` or `{ kind: 'rejected', ... }`) when a `SigningResponse` or `SigningRejected` arrives on the same thread.
- `requestKey(args, { timeoutMs })` sends a `KeyRequest` and resolves to the raw `KeyResponse`. The approve/reject distinction lives in `body.status`.

Responder (controller / wallet) primitives:

- `onSigningRequest(fn)` registers a responder; `fn` returns `{ kind: 'approve', body }` or `{ kind: 'reject', reason }`. The SDK builds and sends the matching response via `buildSigningResponse` / `buildSigningRejected`.
- `onKeyRequest(fn)` registers a responder; `fn` returns a `KeyResponse` body (approved or rejected). The SDK builds and sends the response via `buildKeyResponse`.

Internally `request*` calls a private `awaitThreadResponse` primitive (send, register a waiter keyed by `(thid, response types)`, settle the first match, drop subsequent ones). `on*Request` is a thin wrapper over `updateHandlers` plus the corresponding `build*` helper. Unsolicited messages, and messages on threads with no active waiter, are dispatched to the type-keyed handler map.

## Type-keyed handler map

Handlers are an open map indexed by `msg.type` string. Built-in keys are precisely typed; downstream packages add their own via module augmentation:

```ts
import type { MessageHandlerMap, MessageHandler } from '@algorandfoundation/ac2-sdk/protocol';

declare module '@algorandfoundation/ac2-sdk/protocol' {
  interface MessageHandlerMap {
    'com.acme.payment.request'?: MessageHandler<AcmePaymentRequest>;
  }
}
```

The client merges your handlers over `defaultMessageHandlers` (which just log unhandled messages). You can override at runtime:

```ts
client.updateHandlers({
  'ac2/SigningRequest': async (msg) => showApprovalDialog(msg),
});
```

## Custom transports

`Ac2Transport` is the wire-level abstraction: string-in / string-out (framed AC2 JSON) plus lifecycle and an optional binary side channel.

```ts
interface Ac2Transport {
  send(text: string): void;
  onMessage(handler: (msg: AC2BaseMessage) => void): () => void;
  onRawMessage?(handler: (raw: string) => void): () => void;
  onBinaryMessage?(handler: (data: ArrayBuffer) => void): () => void; // attachments (SPEC §3)
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
  onError(handler: (err: Error) => void): void;
  readonly isOpen: boolean;
  close(): void;
}
```

Two concrete adapters ship with the SDK:

- `rtcDataChannelTransport(channel)` wraps a `RTCDataChannel` (or anything matching `RtcDataChannelLike`). Strings are framed per-message AC2 JSON; non-string frames go to `onBinaryMessage` if registered, otherwise they are dropped (spec-faithful: WebRTC Transport §3 allows binary attachments).
- `createInMemoryTransportPair()` returns two paired transports for tests and demos. No signaling server, no WebRTC.

To add a new transport, implement the interface and pass an instance into `new Ac2Client(transport)`.

## Signaling providers

Once running over WebRTC, *how* the two peers find each other (QR scan, relay, etc.) is a separate concern. The SDK defines a small interface for it:

```ts
interface Ac2ChannelProvider {
  startPairing(opts?): Promise<{
    pairing: { qrPayload: string; metadata?: Record<string, unknown> };
    connect(): Promise<{
      transport: Ac2Transport;
      streamChannel?: RtcDataChannelLike; // optional raw-byte side channel
      peer?: { did?: string }; // populated by providers that authenticate the peer
      close(): Promise<void>;
    }>;
  }>;
}
```

Concrete providers (Liquid Auth, DIDCommRTC, ...) live outside the core SDK so the core stays runtime-agnostic.
