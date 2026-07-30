# @algorandfoundation/ac2-sdk

TypeScript SDK for the [AC2 (Agentic Communication and Control) protocol](https://github.com/algorandfoundation/ac2/blob/master/ac2.md): a peer-to-peer, human-in-the-loop messaging layer that lets AI agents request signing and key operations while users keep custody of their keys.

The SDK is transport-agnostic. The same `Ac2Client` runs over WebRTC DataChannels, an in-memory loopback pair (for tests), or any custom transport implementing `Ac2Transport`.

## Install

```sh
npm install @algorandfoundation/ac2-sdk
```

The core (`.`, `./schema`, `./protocol`, `./transport`, `./signaling`) and the
`./providers/in-memory` channel provider have zero runtime peer dependencies
and work in Node >= 18 and modern browsers. `./providers/liquid-auth` is
Node-only and pulls in three heavy `optionalDependencies` — see
[Channel providers](#channel-providers) below.

## At a glance

`Ac2Client` is symmetric: the same class drives both ends of an AC2 conversation.

- Agent / requester side: `requestSignature`, `requestKey`.
- Wallet / controller side: `onSigningRequest`, `onKeyRequest`.

Both connect to an `Ac2Transport` (a DataChannel, an in-memory loopback pair, or any custom implementation).

### Agent side: issuing requests

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

### Wallet / controller side: answering requests

`onSigningRequest` and `onKeyRequest` register a responder that returns a reply shape. The SDK builds the matching `ac2/SigningResponse`, `ac2/SigningRejected`, or `ac2/KeyResponse` envelope (threading `thid` and addressing `to`/`from` automatically) and sends it on the transport.

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

The responder helpers are sugar over the type-keyed handler map plus the `buildSigningResponse` / `buildSigningRejected` / `buildKeyResponse` builders. The builders are also exported for lower-level control (see [Recipes](#recipes)).

## Recipes

### Receive arbitrary messages

```ts
import { Ac2Client } from '@algorandfoundation/ac2-sdk';

const client = new Ac2Client(transport, {
  handlers: {
    'ac2/SigningRequest': async (msg) => {
      // Show msg.body.description + msg.body.payload to the user, then reply
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

### Decode and validate without a client

```ts
import { decode, isSigningRequest } from '@algorandfoundation/ac2-sdk/schema';

const { message, validation } = decode(rawJson);
if (!validation.valid) console.error(validation.errors);
if (isSigningRequest(message)) {
  // message is typed as AC2SigningRequest
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

## Channel providers

The SDK ships two concrete `Ac2ChannelProvider` implementations (see [EXTENDING.md](./EXTENDING.md#signaling-providers) for the interface) behind their own subpaths, so importing the core never pulls in a provider's dependencies:

- `@algorandfoundation/ac2-sdk/providers/in-memory` — `InMemoryChannelProvider`. No dependencies; pairs two in-process transports directly. Useful for tests and demos.
- `@algorandfoundation/ac2-sdk/providers/liquid-auth` — `LiquidAuthChannelProvider`. Bringup over [Liquid Auth](https://github.com/algorandfoundation/liquid-auth) + WebRTC. Node-only.

`LiquidAuthChannelProvider` needs three Node-only packages — `@roamhq/wrtc` (WebRTC bindings), `socket.io-client`, and `@algorandfoundation/liquid-client` — declared as `optionalDependencies` on the SDK. They are loaded via dynamic `import()` only when `startPairing()` actually runs, so:

- Every other entry point (`.`, `./schema`, `./protocol`, `./transport`, `./signaling`, `./providers/in-memory`) works even when none of them are installed (e.g. `npm install --no-optional`, or a bundler that dropped optional deps).
- If you only need `LiquidAuthChannelProvider` for pairing, install the SDK normally (`optionalDependencies` are installed by default) or add the three packages yourself.
- A missing package fails `startPairing()` with a clear message naming the exact package to install, instead of a raw `ERR_MODULE_NOT_FOUND`.

```ts
import { LiquidAuthChannelProvider } from '@algorandfoundation/ac2-sdk/providers/liquid-auth';

const provider = new LiquidAuthChannelProvider({
  origin: 'https://debug.liquidauth.com',
  // Optional: persist the signaling session cookie across restarts. When
  // omitted, the provider keeps it in memory for its own lifetime only — it
  // still works, it just won't survive a restart. The SDK has no notion of
  // "application state"; the caller adapts its own persistence to this shape.
  sessionCookie: {
    get: (requestId) => myStore.get(requestId),
    set: (requestId, cookie) => myStore.set(requestId, cookie),
  },
});

const handle = await provider.startPairing();
// Render `handle.pairing.qrPayload` however you like (QR code, deep link,
// copyable URL, ...) — the provider does not render to a terminal or any
// other UI; that is entirely the caller's responsibility.
const { transport } = await handle.connect();
```

## Runtime adapters

`@algorandfoundation/ac2-sdk/runtime` is the contract a **runtime adapter** implements to plug an agent runtime into the AC2 daemon (`@algorandfoundation/ac2-cli`). The daemon owns the wallet connection; an adapter is handed inbound frames and a small host to send outbound ones, without needing to know anything about pairing, transports, or the control socket:

```ts
import type { CreateRuntimeAdapter } from '@algorandfoundation/ac2-sdk/runtime';

export const createRuntimeAdapter: CreateRuntimeAdapter = (host, config) => ({
  id: 'my-adapter',
  async handleInbound(message) {
    host.log(`got ${message.payload}`);
    await host.send('ack');
  },
});
```

Publish that as an npm package and point the daemon at it (`AC2_RUNTIME=my-adapter-package`, or the `runtime.adapter` daemon option) — no changes to the daemon itself are needed. The daemon resolves adapters by short built-in name first (`socket`, the default, wraps the daemon's pre-existing control-socket routing) and falls back to `import()`-ing the string as an npm specifier otherwise. See the module JSDoc in `src/runtime/index.ts` for the full lifecycle (`start` → `onConnected` → `handleInbound` → `onDisconnected` → `stop`) and the `locked` rule.

## Spec alignment

The SDK targets DIDComm v2 envelopes (per the AC2 spec's Data Model). Two guarantees worth calling out:

- Single-use request/response. Both `requestSignature` and `requestKey` enforce the spec's "bound to this specific request; single-use" rule. The first matching response on the thread settles the waiter; subsequent ones fall through to the handler map.
- Open extension surface. New message types defined by downstream extensions (e.g. payments, capability grants) plug into the same dispatcher via module-augmented `MessageHandlerMap` entries, with no SDK fork needed. See [EXTENDING.md](./EXTENDING.md).

Streaming (raw bytes over a side channel correlated by `thid`) is intentionally out of scope of the core client. The transport layer exposes hooks (`onBinaryMessage`, `streamChannel`) so a streaming extension can build on top.

## Documentation

- [EXTENDING.md](./EXTENDING.md): package layout, subpath exports, custom transports, custom message types, signaling providers.
- [CONTRIBUTING.md](../CONTRIBUTING.md): repository structure, build, test, and release workflow.

## License

Apache-2.0. See [LICENSE](../../LICENSE) in the repo root.
