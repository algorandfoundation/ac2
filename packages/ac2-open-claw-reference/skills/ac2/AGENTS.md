---
name: ac2-agents
description: 'Behavior rules and AC2 wire-format reference for any agent operating over the `ac2-v1` channel. Names the signing trio messages, threading, transport, and per-message normative requirements from AC2 SPEC §Data Model.'
metadata:
  {
    'openclaw':
      {
        'emoji': '📜',
        'requires': { 'config': ['plugins.entries.ac2.enabled'] },
      },
  }
---

# AGENTS.md — AC2 Behavior Rules & Message Formats

This document is the agent's **operational manifest**: the wire formats it
emits/accepts on `ac2-v1` and the behavior rules that govern when and how it
uses them. It is normative; conflicts with this file are protocol violations.

Keywords MUST / MUST NOT / SHOULD / MAY / OPTIONAL follow BCP 14 (RFC 2119 /
RFC 8174).

## 1. Behavior Rules (summary)

1. **Signing Policy.** For signing operations on the Controller's key, the
   agent MUST follow the **Signature Request** pattern: emit
   `ac2/SigningRequest`, wait for `ac2/SigningResponse` (or
   `ac2/SigningRejected`), and use ONLY the single-use signature returned.
2. **No key custody.** The agent MUST NOT possess, store, observe, or echo
   private key material. (See `SOUL.md` §2 — non-negotiable.)
3. **No signature reuse.** A signature is bound to the exact `payload` of
   the matching `ac2/SigningRequest`. The agent MUST NOT reuse it for any
   other request, modified payload, or replay.
4. **Connection first.** If no `ac2-v1` channel is connected, the agent MUST
   NOT attempt signing flows. Ask the user to pair their wallet.
5. **Rejection is normal.** `ac2/SigningRejected` is a valid outcome. The
   agent MUST surface it to the user and MUST NOT auto-retry the same
   request.
6. **Announce before acting.** Before invoking a tool, send a short chat
   message explaining what is about to happen. Tool cards render output;
   do not paste it back. The signing result or signed payload does not need
   to be relayed back to the user unless explicitly requested.
7. **Honest descriptions.** Every `ac2/SigningRequest.body.description` MUST
   be specific and accurate; it is the only text the user reads before
   approving.

## 2. Envelope (DIDComm v2.0)

All AC2 messages MUST be DIDComm v2.0 compliant:

```json
{
  "@context": ["https://ac2.io/v1"],
  "id": "<uuid>",
  "type": "ac2/<MessageType>",
  "from": "did:key:<agentDid>",
  "to": ["did:key:<controllerDid>"],
  "created_time": 1700000000,
  "expires_time": 1700003600,
  "thid": "<thread-id>",
  "body": {
    /* per-type */
  }
}
```

Normative envelope requirements:

- `created_time` and `expires_time` MUST be **integer Unix seconds** (DIDComm
  v2 §3.2). Implementations MUST NOT emit milliseconds.
- All body fields MUST use **`snake_case`**. `camelCase` variants MUST NOT be
  emitted.
- `thid` carries the conversation thread identifier; frames with no `thid`
  map to the `default` thread.
- `id` SHOULD be a UUID (RFC 4122) and MUST be unique per message.

## 3. Transport (WebRTC DataChannel)

Per AC2 SPEC §WebRTC DataChannel Transport:

1. Channel label MUST be `ac2-v1`.
2. Channel MUST be created with `ordered: true`.
3. Each AC2 message MUST be sent as a **single** DataChannel message
   (one envelope per frame).
4. Attachments MAY be sent as binary DataChannel messages.
5. All messages MUST be end-to-end encrypted via WebRTC DTLS (provided by
   the Liquid Auth transport).

## 4. Core Signing Trio

### 4.1 `ac2/SigningRequest` (agent → Controller)

```json
{
  "@context": ["https://ac2.io/v1"],
  "type": "ac2/SigningRequest",
  "from": "did:key:<agentDid>",
  "to": ["did:key:<controllerDid>"],
  "created_time": 1700000000,
  "expires_time": 1700003600,
  "body": {
    "description": "Sign in to BankApp as alice@example.com",
    "encoding": "base64",
    "payload": "<base64 raw bytes>",
    "schema": "<optional schema id>",
    "key_type": "account",
    "display_hint": "json",
    "sig_hint": "raw-ed25519"
  }
}
```

Body fields:

- `description` — REQUIRED, non-empty string. MUST be shown to the user.
- `encoding` — REQUIRED, MUST be `"base64"`.
- `payload` — REQUIRED, base64 string of raw bytes to sign.
- `schema` — OPTIONAL.
- `key_type` — OPTIONAL, `"account"` (default) | `"identity"`.
- `display_hint` — OPTIONAL, `"text"` | `"json"` | `"hex"`. UX only.
- `sig_hint` — OPTIONAL; see §6. When absent, signer performs Ed25519 over raw
  bytes (legacy default).

### 4.2 `ac2/SigningResponse` (Controller → agent)

```json
{
  "@context": ["https://ac2.io/v1"],
  "type": "ac2/SigningResponse",
  "from": "did:key:<controllerDid>",
  "to": ["did:key:<agentDid>"],
  "created_time": 1700000100,
  "expires_time": 1700003700,
  "body": {
    "signature": "<base64 signature>",
    "public_key": "<base64 32-byte ed25519 public key>",
    "address": "<optional 58-char Algorand address>",
    "key_type": "account"
  }
}
```

- `signature` — REQUIRED, base64, single-use, bound to request `payload`.
- `public_key` — REQUIRED for self-contained verification.
- `address` — OPTIONAL convenience field.
- `key_type` — OPTIONAL; mirrors the request.

### 4.3 `ac2/SigningRejected` (Controller → agent)

```json
{
  "@context": ["https://ac2.io/v1"],
  "type": "ac2/SigningRejected",
  "from": "did:key:<controllerDid>",
  "to": ["did:key:<agentDid>"],
  "body": { "reason": "User rejected the signing request" }
}
```

The agent MUST treat this as a normal outcome and surface `reason` to the user.

## 5. Problem Reports

Errors that are not user rejections MUST be reported via DIDComm
`report-problem/2.0`. The agent MUST NOT invent ad-hoc error envelopes.

## 6. `sig_hint` Catalog (core reference)

| `sig_hint`      | Operation                         |
| --------------- | --------------------------------- |
| `raw-ed25519`   | Ed25519 over raw payload bytes.   |
| `raw-secp256k1` | secp256k1 over raw payload bytes. |

Downstream wallet plugins MAY add chain-specific hints
(`message-algorand`, `message-evm`, `message-solana`, `typed-data-evm`,
`transaction-algorand`, `transaction-evm`, `transaction-solana`). The agent
MUST NOT claim a hint unless it appears in the live catalog returned by
`ac2_capabilities`.

## 7. Threading

AC2 follows DIDComm threading: `thid` identifies the conversation thread;
`pthid` references a parent thread. Streaming spawns a child thread of the
initiating request. The agent MUST preserve `thid` continuity across a
request/response pair.

## 8. KeyRequest / KeyResponse

`ac2/KeyRequest` and `ac2/KeyResponse` are **OPTIONAL** and out of scope for
this reference plugin. If a future build implements them, it MUST obey
SPEC §AC2 KeyRequest / KeyResponse normative constraints (scope, isolation,
single-shot, explicit user consent). `KeyResponse.material` MUST NEVER enter
the agent runtime's conversational context.

## 9. Extensions

The agent MAY load extensions that add patterns or message families.
Extensions MUST NOT weaken the core invariants in `SOUL.md`. If a peer does
not advertise an extension, the agent MUST fall back to the core Signature
Request pattern or refuse the operation.

This reference plugin additionally exposes `ac2_x402_fetch` as
`ac2-ext-x402/fetch`. It is an application/tool capability, not a new AC2 wire
message: x402 Algorand payments still use ordinary `ac2/SigningRequest`
messages for wallet approval.
