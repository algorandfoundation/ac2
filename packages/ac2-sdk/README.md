# @algorandfoundation/ac2-sdk

TypeScript SDK for the [AC2 (Agentic Communication and Control) protocol](https://github.com/algorandfoundation/ac2/blob/master/ac2.md) — a peer-to-peer, human-in-the-loop messaging layer that lets AI agents request signing and key operations while users keep custody of their keys in a wallet or controller app.

The SDK is transport-agnostic. The same `Ac2Client` runs over WebRTC DataChannels, an in-memory loopback pair (for tests), or any custom transport you implement against the `Ac2Transport` interface.

## Install

```sh
npm install @algorandfoundation/ac2-sdk
```

Peer-dependency-free. Works in Node ≥ 18 and modern browsers.

## At a glance

`Ac2Client` is symmetric — the same class drives both ends of an AC2 conversation. The **agent / requester** side uses `requestSignature` / `requestKey`; the **wallet / controller** side uses `onSigningRequest` / `onKeyRequest`. Both connect to an `Ac2Transport` (a DataChannel, an in-memory loopback pair, or any custom implementation).

### Agent side — issuing requests

The top-level barrel re-exports `Ac2Client` directly and the four subpaths as namespaces (`schema`, `protocol`, `transport`, `signaling`). Everything else is reached either via a subpath (`@algorandfoundation/ac2-sdk/transport`, …) or via the namespace barrel — pick whichever style fits your build.

```ts
import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { rtcDataChannelTransport } from '@algorandfoundation/ac2-sdk/transport';

const transport = rtcDataChannelTransport(dataChannel);
const client = new Ac2Client(transport, { onError: console.error });

const outcome = await client.requestSignature(
  {
    from: 'did:key:zAgent...',
    to: 'did:key:zWallet...',
    body: {
      description: 'Sign x402 payment',
      encoding: 'base64',
      payload: '<base64-bytes>',
      sig_hint: 'raw-ed25519',
    },
  },
  { timeoutMs: 30_000 },
);

if (outcome.kind === 'response') {
  console.log(outcome.message.body.signature);
} else {
  console.warn('declined:', outcome.message.body.reason);
}
```

### Wallet / controller side — answering requests

`onSigningRequest` and `onKeyRequest` register a responder that returns a reply shape; the SDK builds the matching `ac2/SigningResponse` / `ac2/SigningRejected` / `ac2/KeyResponse` envelope (threading `thid` and addressing `to`/`from` automatically) and sends it on the transport.

```ts
import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { rtcDataChannelTransport } from '@algorandfoundation/ac2-sdk/transport';

const transport = rtcDataChannelTransport(dataChannel);
const wallet = new Ac2Client(transport, { onError: console.error });

wallet.onSigningRequest(async (req) => {
  const approved = await ui.promptUser(req.body);
  if (!approved) return { kind: 'reject', reason: 'user declined' };
  const sig = await keystore.sign(req.body.payload);
  return {
    kind: 'approve',
    body: {
      signature: sig.signature,
      public_key: sig.publicKey,
      address: sig.address,
      key_type: 'account',
    },
  };
});

wallet.onKeyRequest(async (req) => {
  const derived = await keystore.derive({
    key_type: req.body.key_type,
    derivation_path: req.body.derivation_path,
    purpose: req.body.purpose,
  });
  return {
    status: 'approved',
    key_type: req.body.key_type,
    material: derived.material,
    public_key: derived.publicKey,
    derivation_path: req.body.derivation_path,
  };
});
```

The responder helpers are ergonomic sugar over the type-keyed handler map plus the `buildSigningResponse` / `buildSigningRejected` / `buildKeyResponse` builders — both are exported if you need lower-level control (see [Recipes](#recipes)).

## Package layout

The SDK exposes one top-level entry and four subpaths, each importable independently:

| Import                                  | What you get                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@algorandfoundation/ac2-sdk`           | Namespace barrel re-exporting `schema`, `protocol`, `transport`, `signaling`, plus `Ac2Client` / `Ac2ClientOptions` |
| `@algorandfoundation/ac2-sdk/schema`    | Pure types, type guards, decoding, JSON-schema validation                                                           |
| `@algorandfoundation/ac2-sdk/protocol`  | `Ac2Client`, low-level message factories (`createSigningRequest`, …), reply builders, type-keyed `handleMessage`    |
| `@algorandfoundation/ac2-sdk/transport` | `Ac2Transport` interface + concrete `rtcDataChannelTransport` and `createInMemoryTransportPair`                     |
| `@algorandfoundation/ac2-sdk/signaling` | `Ac2ChannelProvider` interface for bringup adapters (Liquid Auth, DIDCommRTC, …)                                    |

ESM consumers should prefer the subpaths (better tree-shaking). CJS consumers can reach every symbol through the namespace barrel:

```ts
import * as ac2 from '@algorandfoundation/ac2-sdk';
const transport = ac2.transport.rtcDataChannelTransport(dataChannel);
const client = new ac2.Ac2Client(transport);
```

## Core concepts

### `Ac2Client` — symmetric request/response over a single channel

`Ac2Client` wraps an `Ac2Transport` and exposes both sides of every AC2 request/response pair. Both built-in pairs are single-use (one request → one matching response) with `thid`-based correlation.

**Requester (agent) primitives:**

- `requestSignature(args, { timeoutMs })` — sends a `SigningRequest` and resolves to a discriminated `SigningOutcome` (`{ kind: 'response', ... }` or `{ kind: 'rejected', ... }`) when a `SigningResponse` or `SigningRejected` arrives on the same thread.
- `requestKey(args, { timeoutMs })` — sends a `KeyRequest` and resolves to the raw `KeyResponse`. The approve/reject distinction lives in `body.status`.

**Responder (controller / wallet) primitives:**

- `onSigningRequest(fn)` — registers a responder; `fn` returns `{ kind: 'approve', body }` or `{ kind: 'reject', reason }`. The SDK builds and sends the matching response via `buildSigningResponse` / `buildSigningRejected`.
- `onKeyRequest(fn)` — registers a responder; `fn` returns a `KeyResponse` body (approved or rejected). The SDK builds and sends the matching response via `buildKeyResponse`.

Internally `request*` calls a private `awaitThreadResponse` primitive — send, register a waiter keyed by `(thid, response types)`, settle the first match, drop subsequent ones — and `on*Request` is a thin wrapper over `updateHandlers` + the corresponding `build*` helper. Unsolicited messages — and messages on threads with no active waiter — are dispatched to the type-keyed handler map (below).

### Type-keyed handler map

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

### Transport

`Ac2Transport` is the wire-level abstraction — string-in / string-out (framed AC2 JSON) plus lifecycle and an optional binary side channel:

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

- `rtcDataChannelTransport(channel)` — wraps a `RTCDataChannel` (or anything matching `RtcDataChannelLike`). Strings are framed per-message AC2 JSON; non-string frames go to `onBinaryMessage` if registered, or are silently dropped (spec-faithful: WebRTC Transport §3 allows binary attachments).
- `createInMemoryTransportPair()` — returns two paired transports for tests and demos. No signaling server, no WebRTC.

### Signaling provider (bringup)

Once you’re running over WebRTC, _how_ the two peers find each other (QR scan, relay, etc.) is a separate concern. The SDK defines a small interface for it:

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

Concrete providers (Liquid Auth, DIDCommRTC, …) live outside the core SDK so the core stays runtime-agnostic. See the reference plugin in this monorepo for a Liquid Auth implementation.

## Recipes

### Receive arbitrary messages

```ts
import { Ac2Client } from '@algorandfoundation/ac2-sdk';
// `handlers` / `onUnknown` are passed via `Ac2ClientOptions`.

const client = new Ac2Client(transport, {
  handlers: {
    'ac2/SigningRequest': async (msg) => {
      // Show the user msg.body.description + msg.body.payload, then reply
      // with buildSigningResponse(...) or buildSigningRejected(...).
    },
  },
  onUnknown: (msg) => console.warn('unhandled', msg.type),
  onError: (err) => console.error(err),
});
```

### Build a response by hand (controller / wallet side)

```ts
import {
  buildSigningResponse,
  buildSigningRejected,
  buildKeyResponse,
} from '@algorandfoundation/ac2-sdk/protocol';

const response = buildSigningResponse({
  request: incomingRequest, // for thid + addressing
  from: 'did:key:zWallet...',
  body: { signature, public_key, key_type: 'account' },
});
transport.send(JSON.stringify(response));
```

### Decode + validate without a client

```ts
import { decode, isSigningRequest } from '@algorandfoundation/ac2-sdk/schema';

const { message, validation } = decode(rawJson);
if (!validation.valid) console.error(validation.errors);
if (isSigningRequest(message)) {
  /* message is typed as AC2SigningRequest */
}
```

### Loopback transport for tests

```ts
import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { createInMemoryTransportPair } from '@algorandfoundation/ac2-sdk/transport';
import { buildSigningResponse } from '@algorandfoundation/ac2-sdk/protocol';
import { isSigningRequest } from '@algorandfoundation/ac2-sdk/schema';

const [agent, wallet] = createInMemoryTransportPair();

wallet.onMessage((msg) => {
  if (isSigningRequest(msg)) {
    wallet.send(
      JSON.stringify(
        buildSigningResponse({
          request: msg,
          from: 'did:key:zWallet',
          body: { signature: 'sig', public_key: 'pk', key_type: 'account' },
        }),
      ),
    );
  }
});

const client = new Ac2Client(agent);
const outcome = await client.requestSignature({
  /* ... */
});
```

## Spec alignment

The SDK targets DIDComm v2 envelopes (per the AC2 spec’s Data Model). Two specific guarantees worth calling out:

- **Single-use request/response.** Both `requestSignature` and `requestKey` enforce the spec’s "bound to this specific request; single-use" rule. The first matching response on the thread settles the waiter; subsequent ones fall through to the handler map.
- **Open extension surface.** New message types defined by downstream extensions (e.g. payments, capability grants) plug into the same dispatcher via module-augmented `MessageHandlerMap` entries — no SDK fork needed.

Streaming (raw bytes over a side channel correlated by `thid`) is intentionally out of scope of the core client. The transport layer exposes the hooks (`onBinaryMessage`, `streamChannel`) so a streaming extension can build on top without modifying the SDK.

## License

See [LICENSE](../../LICENSE) in the repo root.
