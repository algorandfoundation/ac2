# @ac2/ac2-sdk

SDK for the [AC2 (Agentic Communication and Control) Protocol](https://github.com/algorandfoundation/ac2/blob/master/ac2.md) — a peer-to-peer authenticated messaging system for human-in-the-loop AI agent signing workflows. Agents request signing operations; users approve through their own wallet or application. All communication is end-to-end encrypted via [Liquid Auth](https://github.com/algorandfoundation/liquid-auth).

## Install

```sh
npm install @ac2/ac2-sdk
```

## Package Structure

The SDK is a single package with three export paths:

| Path | Description |
|------|-------------|
| `@ac2/ac2-sdk/schema` | Pure schema: types, type guards, decoding, and validation |
| `@ac2/ac2-sdk/protocol` | Message factories and dispatcher built on top of the schema |
| `@ac2/ac2-sdk/transport` | Liquid Auth transport integration |

## Usage

### `@ac2/ac2-sdk/schema`

Low-level schema primitives. Use this when you need direct control over decoding or validation.

```ts
import { decode, validate, isSigningRequest } from "@ac2/ac2-sdk/schema";

const { message, validation } = decode(rawJson);

if (!validation.valid) {
  console.error(validation.errors);
}

if (isSigningRequest(message)) {
  console.log(message.body.payload); // typed as AC2SigningRequest
}
```

### `@ac2/ac2-sdk/protocol`

Message factories and a handler dispatcher. Use this to build and process AC2 messages.

**Creating messages:**

```ts
import { createSigningRequest } from "@ac2/ac2-sdk/protocol";

const msg = createSigningRequest(
  {
    id: "msg-1",
    from: "did:example:agent",
    to: ["did:example:user"],
    created_time: Date.now(),
  },
  {
    payload: "<base64-encoded-bytes>",
    encoding: "base64",
    context: "Sign this transaction",
  },
);
```

**Handling incoming messages:**

```ts
import { handleMessage } from "@ac2/ac2-sdk/protocol";
import type { MessageHandlers } from "@ac2/ac2-sdk/protocol";

const handlers: MessageHandlers = {
  onSigningRequest: async (msg) => {
    // prompt user to approve
  },
  onSigningResponse: async (msg) => {
    // use the signature
  },
  onUnknown: async (msg, validation) => {
    console.warn("Unhandled message", msg.type, validation.errors);
  },
};

await handleMessage(rawJson, handlers);
```

### `@ac2/ac2-sdk/transport`

Liquid Auth transport integration for establishing authenticated peer-to-peer connections. This layer handles WebRTC DataChannel setup using FIDO2/WebAuthn credentials.

> **Note:** Transport bindings are currently in progress. See the [AC2 spec](https://github.com/algorandfoundation/ac2/blob/master/ac2.md) for the full transport model.
