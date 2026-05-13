---
title: AC2 - Agentic Communication and Control Protocol
shortname: ac2
status: Draft
editors:
  - Bruno Martins <bruno.martins@algorand.foundation>
  - Michael Feher <michael.feher@algorand.foundation>
  - Marc Vanlerberghe <marc@algorand.foundation>
  - Mohammad Ghiasi <emg110@goplausible.com>
created: 2026-04-01
---

## Abstract

This specification defines the **AC2 (Agentic Communication and Control) Protocol**, a peer-to-peer authenticated messaging system designed for secure communication between users and AI agents. The core protocol covers human-in-the-loop signing — agents request signatures from users, who validate and approve through their own wallet or application, with signatures then returned to the agent. The agent itself holds no keys and never sees key material; key custody for the agent's own identity lives in the agent's tooling (e.g., agent-internal tools, MCP tools, or OWS wallet toolings). Additional capabilities such as autonomous operation under pre-authorized bounds are defined as separate extensions to this core (see **Extensions** below).

AC2 uses **Liquid Auth** as its transport mechanism - an authenticated peer-to-peer connection establishment protocol that leverages FIDO2/WebAuthn and WebRTC DataChannels to create sovereign, end-to-end encrypted communication channels between controllers (users) and agents. Unlike traditional messaging systems, AC2 does not rely on centralized message relay servers; instead, it establishes direct P2P connections through a signaling service that facilitates the initial handshake.

The protocol supports both real-time streaming for AI interactions (voice, text, or video from the Controller to the agent; voice, text, or file artifacts back from the agent) and request/response patterns for discrete operations. AC2 uses **DIDComm-compliant message formats** [[didcomm-messaging](https://identity.foundation/didcomm-messaging/spec/)], enabling interoperability with existing decentralized identity infrastructure while extending the protocol for real-time streaming use cases.

Authentication leverages Decentralized Identifiers (DIDs) with Passkey-based credentials, providing phishing-resistant security without passwords. AC2 is use-case agnostic, supporting web3 workflows (x402 payments, MPP machine payments — both `charge` and `session` intents), code signing (git commits), document signatures, and any other digital signing operation where the signing key is held by the user and the signature is requested per-operation. Operations on keys held by the agent's tooling, including autonomous operation within pre-authorized bounds, are defined by separate AC2 extensions.

## Status of This Document

This document is a **Draft** specification. It is intended for community review and feedback. Changes are expected as the specification matures.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14) [[RFC2119](https://www.rfc-editor.org/rfc/rfc2119)] [[RFC8174](https://www.rfc-editor.org/rfc/rfc8174)] when, and only when, they appear in all capitals, as shown here.

*This section is non-normative.*

## Introduction

*This section is non-normative.*

### Background

Current messaging systems for AI agent interaction (WhatsApp, Telegram, email) were not designed with autonomous agents in mind. They lack:

1. **Cryptographic identity verification** - No way to verify agent authenticity
2. **Human-in-the-loop signing** - Users must fully trust agents with private keys
3. **Standardized capability grants** - No protocol for temporary, revocable authority
4. **Streaming with authentication** - Real-time AI responses lack proper auth

AC2 addresses these gaps by providing a protocol where:
- Agents MUST NOT access the user's private keys and MUST NOT sign on the user's account
- For operations requiring the user's key, agents request and the user approves via familiar interfaces
- The agent itself holds no keys; key custody for the agent's own identity lives in the agent's tooling
- Extensions to this core MAY introduce additional flows such as autonomous operation under pre-authorized bounds
- All communication is authenticated and end-to-end encrypted

### Design Goals

1. **Human-Centric Control**: Users retain control over their own keys and over the authority granted to agents. Control is exercised either per-operation — approving each signing request — or via bounded pre-authorization that can be revoked at any time.
2. **Decentralized Identity**: Both Controller and Agent are identified by W3C Decentralized Identifiers (DIDs) — verifiable, portable, and not tied to any centralized identity provider.
3. **Passwordless Security**: Passkey-based authentication.
4. **Real-Time Streaming**: Support for voice / text / video input from the Controller and voice / text / file artifact output from the agent, with live statistics
5. **Use-Case Agnostic**: Works with any digital signing operation
6. **Privacy-Preserving**: End-to-end encryption, minimal metadata exposure
7. **Interoperable**: Standard message formats, transport agnostic

### Relationship to Other Protocols

| Protocol | Relationship to AC2 |
|----------|---------------------|
| A2A (Agent2Agent) | Not in core; may be supported via an AC2 extension that integrates A2A patterns onto AC2 transport |
| MCP (Model Context Protocol) | No direct relationship; AC2 operates at the transport/authentication layer |
| **DIDComm** | **AC2 uses DIDComm v2.0 message format** for plaintext messages, enabling interoperability with existing decentralized identity infrastructure |
| WebAuthn | AC2 uses Liquid Auth which extends FIDO2/WebAuthn with the Liquid Extension |
| **Liquid Auth** | **Required transport layer** for AC2; handles P2P connection establishment and authentication |

### Examples of Use

*This section is non-normative.*

**AI Chat with Voice / Video**: User streams voice or video to the agent; agent streams back a text, voice, or file-artifact response with real-time token usage statistics.

**x402 Payment Flow**:
1. Agent identifies need to pay for API access
2. Agent sends signing request to user
3. User reviews payment details in wallet app
4. User signs the request and the signature is returned to the agent
5. Agent completes payment with user's signature

**MPP Charge (one-off payment — HTTP Payment Authentication Scheme, `charge` intent)**:
1. Agent makes a request to a paid resource
2. Server responds with `402 Payment Required` carrying an MPP challenge for the `charge` intent (e.g., the `algorand` payment method — see draft-algorand-charge)
3. Agent forwards the payment authorization to the user for signing (Signature Request pattern); the user signs and the signature is returned to the agent
4. Agent submits the signed transaction

**MPP Session (metered / streaming — HTTP Payment Authentication Scheme, `session` intent)**:
1. Agent makes a request to a metered API (e.g., LLM inference, streaming data)
2. Server responds with `402 Payment Required` carrying an MPP challenge for the `session` intent (e.g., the `algorand` payment method — see draft-algorand-session)
3. Agent forwards the channel-open authorization to the user for signing (Signature Request pattern); the user signs the deposit transaction group, the signature is returned to the agent, and the agent presents vouchers per metered unit

**Git Commit Signing**:
1. Agent prepares code changes
2. Agent requests commit signature from user
3. User reviews diff in signing app
4. User signs with his GPG Key, agent receives signature
5. Agent pushes signed commit

`note`: __The above Git example requires a special GPG bridge program to forward signing requests from the agent to the user's wallet. The bridge itself is outside the scope of this protocol but can be implemented using AC2's signature-request flow.__

Use cases requiring autonomous payments or asset transfers (background payments, metered streaming with off-chain vouchers, scheduled transfers) are out of core scope and expected to be covered by extensions (e.g. a pre-authorized-operations extension that adds capability grants, spend bounds, and receipts on top of the core signing trio).

## Conformance

TBD

## Terminology

TBD 

## Architecture Overview

*This section is non-normative.*

### System Components

```mermaid
graph LR;
    Controller(User) <-- "AC2" --> Agent;
    Passkey --> Controller;
    Agent --> LLM/API;

```

### Trust Model

**Human-in-the-loop signing** — agent requests, user signs on their own key:

```mermaid
graph TD;
    User -- "gives pubkey / DID" --> Agent;
    Agent -- "requests signatures on user's key" --> User;
    User -- "signs with private key" --> User;
    User -- "returns signature" --> Agent;
```

Agents MUST NOT hold keys. Keys for the agent's own identity are held by the agent's tooling (e.g., agent-internal tools, MCP tools, or OWS wallet toolings); the agent invokes tool calls and the tooling performs any signing the agent's tooling is configured to perform.

**Controller Components**:
- **Wallet/Identity Manager**: Liquid Auth-compatible wallet with FIDO2/WebAuthn support
- **Signaling Client**: WebSocket client for Liquid Auth signaling
- **WebRTC Handler**: Manages DataChannel for P2P communication
- **Signing Interface**: Presents operations for user approval
- **AC2 Client**: Processes AC2 messages over DataChannel

**Agent Components**:
- **Signaling Server**: Liquid Auth service for connection establishment
- **Request Builder**: Constructs signing requests with context
- **Signature Response Handler**: Receives issued signatures from Controller
- **AC2 Client**: Processes AC2 messages over DataChannel

**Liquid Auth Infrastructure**:
- **Signaling Server**: WebSocket server for initial handshake. The message-relay and room backing is an implementation choice (e.g., Redis pub/sub, Cloudflare Durable Objects, in-memory for single-node deployments, or equivalent).
- **FIDO2 Server**: Handles WebAuthn attestation and assertion
- **No Message Relay**: Messages flow directly over WebRTC DataChannel

### Communication Patterns

The core protocol defines two named communication patterns: **Streaming** and **Signature Request**. Pattern names are the canonical identifiers used throughout this specification and in agent configuration materials. Extensions MAY define additional patterns and MUST advertise them via DIDComm `discover-features/2.0`.

**Streaming (for AI Chat)**
```
Controller ──► Agent:     Stream Request (voice / text / video)
Controller ◄── Agent:     Stream Response (text, voice, or file artifact)
                          ├─ Content chunks
                          ├─ Usage statistics
                          └─ End-of-stream marker
```

**File artifacts**: when the agent produces a file as part of a response (generated document, image, code file, report, etc.), it is delivered as a DIDComm attachment on the relevant response message. Large files MAY be sent as binary DataChannel messages per the WebRTC DataChannel Transport section. Files are not streamed as part of the Streaming token stream — they are discrete artifacts attached to messages.

**Signature Request (for operations on the Controller's keys — x402 with user's wallet, git, documents)**
```
Agent ──► Controller:     Signature Request
         (with context: amount, recipient, purpose)
         
Controller:               Review & Approve (via Passkey auth)

Controller ──► Agent:      Issued Signature
                          (bound to this specific request; single-use)

Agent:                    Execute operation with the issued signature
Agent ──► Controller:     Receipt/Confirmation
```

### Security Model

AC2 assumes a **semi-trusted Agent model**:
- Agents are authenticated (via DID + Passkey)
- Agents MUST NOT access the Controller's private keys and MUST NOT sign on the Controller's account
- For operations on the Controller's keys, Agents MUST request signatures from the Controller and Controllers MUST review each request
- All communication is encrypted and authenticated

## Data Model

AC2 messages MUST be compliant with [DIDComm v2.0 message formats](https://identity.foundation/didcomm-messaging/spec). Core defines the signing trio and the streaming initiation message; extensions add additional message families (capability grants, discovery, attachments, etc.).

### Examples

#### Plan Message Structure

The following structure is based on DIDcommv2 message format, re-used for AC2 messages:

```json
{
  "id": "1234567890",
  "type": "<message-type-uri>",
  "from": "did:example:alice",
  "to": ["did:example:bob"],
  "created_time": 1516269022,
  "expires_time": 1516385931,
  "body": {
    "message_type_specific_attribute": "and its value",
    "another_attribute": "and its value"
  }
}
```

`created_time` and `expires_time` are integer **Unix timestamps in seconds** (per [DIDComm v2 §3.2](https://identity.foundation/didcomm-messaging/spec/#message-headers)). Implementations MUST NOT emit milliseconds.

![DIDComm Message Structure](https://identity.foundation/didcomm-messaging/spec/#plaintext-message-structure)

#### With Attachments

```json
{
  "id": "1234567890",
  "type": "<message-type-uri>",
  "from": "did:example:alice",
  "to": ["did:example:bob"],
  "created_time": 1516269022,
  "expires_time": 1516385931,
  "body": {
    "message_type_specific_attribute": "and its value",
    "another_attribute": "and its value"
  },
  "attachments": [
    {
      "id": "attachment-id",
      "media_type": "application/json",
      "data": {
        "json": {
          "key": "value"
        }
      }
    }
  ]
}
```

![Message with Attachment](https://identity.foundation/didcomm-messaging/spec/#message-with-attachment)

#### AC2 Message Examples

Capability discovery is **not** in the core spec. If two peers need to negotiate which extensions or message families they both support, they SHOULD use an AC2 discovery extension or an extension-specific discovery mechanism (e.g. an agent-card-style descriptor). Core peers MAY assume signing trio support by default. Problems are reported via DIDComm `report-problem/2.0`.

##### Signing Request

```json
{
  "@context": ["https://ac2.io/v1"],
  "type": "ac2/SigningRequest",
  "from": "did:example:agent",
  "to": ["did:example:user"],
  "created_time": 1700000000,
  "expires_time": 1700003600,
  "body": {
    "description": "Requesting signature for x402 payment",
    "encoding": "base64",
    "payload": "base64-encoded data to sign",
    "schema": "schema of the payload (e.g., x402 payment schema)",
    "key_type": "account",
    "display_hint": "json",
    "sig_hint": "message-algorand"
  }
}
```

`body` fields:

- `description` (REQUIRED, non-empty string) — human-readable purpose, MUST be shown to the user in the approval prompt.
- `encoding` (REQUIRED, MUST be `"base64"`) — encoding of `payload`.
- `payload` (REQUIRED, base64 string) — raw bytes the signer will sign. Whether the signer applies a chain-specific prefix or encoding before signing is determined by `sig_hint` below; when `sig_hint` is absent, the signer signs the raw bytes as Ed25519 input (the historical Algorand-only default).
- `schema` (OPTIONAL, string) — schema identifier for the payload (e.g., x402 payment schema).
- `key_type` (OPTIONAL, `"account"` | `"identity"`, default `"account"`) — which key the signer SHOULD use. The signer MAY refuse a `key_type` it does not support and respond with `ac2/SigningRejected`.
- `display_hint` (OPTIONAL, `"text"` | `"json"` | `"hex"`) — UX hint for how the wallet SHOULD preview `payload` to the user. Has no cryptographic effect. The wallet MAY auto-detect if the field is absent.
- `sig_hint` (OPTIONAL, one of `"raw-ed25519"` | `"raw-secp256k1"` | `"message-algorand"` | `"message-evm"` | `"message-solana"` | `"typed-data-evm"` | `"transaction-algorand"` | `"transaction-evm"` | `"transaction-solana"`) — explicit cryptographic-operation selector. Each value identifies one operation (curve, prefix, canonical encoding) the signer performs, and the format of the signature returned. Has no effect on UX preview (that's `display_hint`'s job). When absent, the signer performs Ed25519 over raw `payload` bytes (the historical default). Implementations MUST reject unknown values or pairings inconsistent with the selected signer's chain/curve via `ac2/SigningRejected`. The per-value byte-level semantics are defined by chain conventions (ARC-60, EIP-191, EIP-712, EIP-2718, Algorand canonical `TX`-prefixed msgpack, etc.) and agreed on out-of-band between signer and verifier; new values are added by extension.

The `payload` field MUST be shown to the user in both its raw form and a human-readable form (e.g., "Pay 0.5 ALGO to recipient XYZ for API access") before the user approves the signing request.

##### Signing Response

```json
{
  "@context": ["https://ac2.io/v1"],
  "type": "ac2/SigningResponse",
  "from": "did:example:user",
  "to": ["did:example:agent"],
  "created_time": 1700000100,
  "expires_time": 1700003700,
  "body": {
    "signature": "base64-encoded signature",
    "public_key": "base64-encoded 32-byte ed25519 public key",
    "address": "58-char Algorand address",
    "key_type": "account"
  }
}
```

`body` fields:

- `signature` (REQUIRED, base64 string) — Ed25519 signature over the raw bytes of the request `payload`.
- `public_key` (REQUIRED, base64 string) — the 32-byte Ed25519 public key the signature verifies against. REQUIRED for self-contained verification when the signer uses an account key whose public key is not embedded in `from`.
- `address` (OPTIONAL, string) — 58-character Algorand address derived from `public_key`. Convenience field for human-readable audit logs.
- `key_type` (OPTIONAL, `"account"` | `"identity"`, default `"account"`) — which key actually signed; mirrors the request's `key_type`.

**Naming convention.** All AC2 message body fields use **`snake_case`** for consistency with DIDComm v2 envelope headers. Implementations MUST NOT emit `camelCase` variants of these fields.

##### Signing Rejected

```json
{
  "@context": ["https://ac2.io/v1"],
  "type": "ac2/SigningRejected",
  "from": "did:example:user",
  "to": ["did:example:agent"],
  "created_time": 1700000100,
  "expires_time": 1700003700,
  "body": {
    "reason": "User rejected the signing request"
  }
}
```

### Liquid Extension

The Liquid Extension extends standard FIDO2/WebAuthn authentication by binding the credential to a blockchain address. This creates a "second signature" where the authenticator signs the WebAuthn challenge with its internal Passkey (P-256), and also produces a signature using an Ed25519 key associated with an Algorand address.

This extension allows the relying party (dApp) to verify that the user not only possesses a valid Passkey but also controls a specific blockchain account.


**Attestation Extension Results**:

```json
{
  "liquid": {
    "type": "algorand",
    "address": "2SPDE6XLJNXFTOO7OIGNRNKSEDOHJWVD3HBSEAPHONZQ4IQEYOGYTP6LXA",
    "signature": "<signature>",
    "requestId": "019097ff-bb8c-7514-a0c6-5209d2405a4a",
    "device": "Pixel 8 Pro"
  }
}
```

The `signature` field in the Assertion result is a base64url-encoded Ed25519 signature of the `challenge` produced by the private key corresponding to the Algorand `address`. This binding ensures that the WebRTC session is established with a verified blockchain identity.

**Assertion Extension Results**:

```json
{
  "liquid": {
    "requestId": "019097ff-bb8c-7514-a0c6-5209d2405a4a"
  }
}
```

### WebRTC DataChannel Transport

Once the Liquid Auth handshake completes, AC2 messages are transported over the WebRTC DataChannel.

**Normative Requirements**:

1. **Channel Label**: The DataChannel MUST be created with label `ac2-v1`
2. **Message Framing**: Each AC2 message MUST be sent as a single DataChannel message
3. **Binary Data**: Attachments MAY be sent as binary DataChannel messages
4. **Ordered Delivery**: The DataChannel MUST be created with `ordered: true`
5. **Encryption**: All messages MUST be end-to-end encrypted via WebRTC's DTLS

**Non-Normative Example**:

```javascript
// Agent creates DataChannel
const dataChannel = peerConnection.createDataChannel('ac2-v1', {
  ordered: true
});

dataChannel.onopen = () => {
  dataChannel.send(JSON.stringify({
    "@context": ["https://ac2.io/v1"],
    "id": "msg-1",
    "type": "ac2/SigningRequest",
    "from": "did:example:agent",
    "to": ["did:example:user"],
    "created_time": Math.floor(Date.now() / 1000),
    "body": {
      "description": "Sign in to Example",
      "encoding": "base64",
      "payload": "<base64-encoded bytes>"
    }
  }));
};
```

### Signaling Protocol

The signaling server facilitates the WebRTC handshake without accessing message content.

## Authentication

### DID-Based Identity

**Normative Requirements**:

1. **DID Methods**: Implementations MUST support `did:key` per [[did-key](https://w3c-ccg.github.io/did-method-key/)] and SHOULD support `did:web`
2. **Key Types**: Ed25519 keys REQUIRED for signatures; secp256k1 OPTIONAL for blockchain operations; post-quantum schemes such as `falcon-512` OPTIONAL
3. **Resolution**: Implementations MUST resolve DIDs per [[did-resolution](https://w3c-ccg.github.io/did-resolution/)]
4. **Discovery**: Agent DIDs MUST be discoverable via `.well-known/did.json` (for `did:web` DIDs) or `.well-known/did-configuration.json` per [[well-known-did-configuration](https://identity.foundation/.well-known/resources/did-configuration/)] (for any DID method, including `did:key`)

### Agent DID Key Origin

An agent's signing key MAY be produced in either of two ways:

1. **Derived key** — the agent's keypair is deterministically derived from the Controller's seed via an HD scheme appropriate to the key type (e.g., BIP32-Ed25519 / [[ARC-52](https://github.com/algorandfoundation/ARCs/blob/main/ARCs/arc-0052.md)] for Ed25519, BIP32 for secp256k1). HD derivation applies only to key types for which a standard HD scheme exists.
2. **Independent key** — the agent's keypair is generated freshly with no relationship to the Controller's seed.

When derived, the agent DID Document MAY include a `keyOrigin` hint:

```json
"keyOrigin": {
  "method": "arc52",
  "derivationPath": "m/44'/283'/1'/0/0"
}
```

Path indices are numeric per BIP32/BIP44; non-numeric segments are not allowed. The example reserves account index `1'` for agent keys (vs. `0'` for the Controller's own keys), so funds and signing scopes stay segregated.

Consumers MUST NOT rely on `keyOrigin` for trust decisions.

### Capability Identifier Namespacing

Capability discovery itself is out of core scope (covered by an AC2 discovery extension, or by an extension-specific mechanism such as an agent-card-style descriptor). When peers do exchange capability identifiers, the identifiers SHOULD follow this three-tier namespacing convention:

| Tier | Namespace pattern | Defined by | Example |
|------|-------------------|-----------|---------|
| **Core** | `ac2/<name>` | This specification | `ac2/sign` |
| **Extension** | `<extension-shortname>/<name>` | An AC2 extension specification | e.g. `ac2-ext-<name>/<capability>` |
| **Application** | `<reverse-domain>/<name>` | The deploying application | `com.example.research/data-fetch` |

Reverse-domain naming for application capabilities ensures global uniqueness without a central registry; each domain owner controls their own namespace.

### Passkey Authentication

**Normative Requirements**:

1. **WebAuthn**: Passkey authentication MUST conform to [[webauthn-2](https://www.w3.org/TR/webauthn-2/)]
2. **Resident Keys**: Authenticators SHOULD support client-side discoverable credentials
3. **User Verification**: User verification (PIN, biometrics) REQUIRED for signing operations
4. **Attestation**: Attestation OPTIONAL but RECOMMENDED for high-security scenarios

**Authentication Flow** (non-normative):

```
Controller                          Agent
     │                               │
     │─── 1. Connect with DID ─────►│
     │                               │
     │◄── 2. Challenge (WebAuthn) ───│
     │                               │
     │─── 3. Passkey Response ───────►│
     │                               │
     │◄── 4. Session Established ────│
```

## Extensions

AC2 is designed to be extended. Extensions add new communication patterns, message types, and behaviors on top of the core foundation (DID-based identity, Liquid Auth transport, DIDComm message format, the signing trio, the streaming pattern, plugin model). Discovery, attachments, and HITL approvals are extensions, not core. The streaming **pattern** is core (see *Communication Patterns* and *Streaming Protocol*); concrete stream-chunk **framing** is implementation-profiled.

**Extension naming**: extension message types use the `ac2/` namespace and SHOULD include a JSON-LD context entry of the form `https://ac2.io/ext/<extension-name>/v<version>`.

**Discovery**: extensions MUST advertise themselves via DIDComm `discover-features/2.0` using a feature identifier of the form `ac2-ext-<extension-name>/<version>`.

**Layering**: extensions MAY define new patterns; MAY introduce new message types; MAY add fields to permit additional flows over Signature Request, Agent DID Key Origin, and Passkey Authentication; MUST NOT weaken the core invariants (in particular, an extension MUST NOT permit an agent to access or sign on the Controller's keys).

**Fallback**: if a peer does not advertise an extension, parties using flows defined by that extension MUST fall back to the core Signature Request pattern (or refuse the operation).

**Illustrative extensions** (placeholders — none are part of this core specification; each would be published as its own separate document under the rules above):

- A **discovery extension** that adds `ac2/CapabilityList` (push/pull) and `ac2/GetCapability` messages for cross-extension capability enumeration. Opt-in; core peers MAY assume signing-trio support without exchanging a list.
- A **pre-authorized operations extension** that adds a pre-authorized communication pattern (e.g. tooling-controlled account or on-chain vault scenarios) and messages along the lines of `AgentTopUpRequest`, `AgentCapabilityGrant`, `AgentSpendReceipt`. Scoped to payments and asset-transfer signing.
- An **A2A (Agent-to-Agent) extension** that translates the Google A2A protocol's AgentCard, task lifecycle, message parts, and streaming patterns into DIDComm messages over AC2 transport, with DID-based mutual agent authentication and Verifiable-Credential-based owner consent for agent-to-agent connections.

## Streaming Protocol

AC2 supports real-time streaming (see the Streaming pattern in Architecture Overview). Stream initiation uses a standard DIDComm message; stream chunks are then framed over the established WebRTC DataChannel. Streaming follows the DIDComm threading conventions (`thid` / `pthid`) — the stream spawns a child thread of the initiating request. Concrete stream-chunk framing is out of scope of this version and is expected to be profiled by implementations.

## Privacy Considerations

*This section is non-normative.*

### Data Minimization

AC2 implementations should minimize data collection:

- Don't store message content after delivery
- Don't log unnecessary metadata
- Don't share data with third parties
- Allow users to export and delete their data

### Consent

Controllers should implement:

- Clear consent for session establishment
- Granular consent per operation type
- Ability to review and revoke consent
- Transparency about what agents can access

## Agent Configuration for Digital Signatures

This section applies to signing operations that require the Controller's key. Other operation classes (e.g., autonomous operation under pre-granted bounds) are defined by AC2 extensions.

### Implementation Layer: AC2 Plugin on the Agent Framework

AC2 enforcement at the agent is realized as a **plugin** loaded by the host agent framework (e.g., Claude Code, OpenClaw). The plugin wires AC2 messages, detects signature events, intercepts operations, and injects the AC2 signing flow.

A conforming AC2 plugin uses the enforcement mechanisms exposed by the host framework. These fall into four classes:

1. **Rules / context / memory markdowns** — framework-specific guidance files read by the LLM (e.g., `CLAUDE.md`, `SOUL.md`, `MEMORY.md`).
2. **Hooks** — pre/post event callbacks the framework exposes (e.g., pre-tool-use, post-message, user-prompt-submit, stop). Invoked regardless of LLM cooperation.
3. **SDK plugin entry points** — typed function registration exposed by the framework's plugin SDK.
4. **Skills** — capability definitions (typically `SKILLS.md` or equivalent).

### Framework Configuration Mechanisms (context-markdown class)

| Mechanism | File/Location | Purpose |
|-----------|---------------|---------|
| **System Instructions** | `SOUL.md`, system prompt, character files | Core identity and constraints |
| **Agent Manifest** | `AGENTS.md` | Behavior rules and message formats |
| **Capability Definition** | `SKILLS.md`, tool schemas | Skill definitions with AC2 workflows |
| **Memory/Context** | `MEMORY.md`, `CLAUDE.md`, conversation history | State tracking and project rules |
| **Identity Declaration** | `IDENTITY.md`, agent cards | Compliance declaration |
| **User Preferences** | `USER.md`, settings | Controller configuration |

### Core Principle

When an agent requires a digital signature **on the Controller's key**, it **MUST**:

1. Request the signature from the controller (user) via AC2 messaging
2. Wait for controller approval and the issued signature
3. Use ONLY the controller-provided signature

The wire format for `ac2/SigningRequest` and `ac2/SigningResponse` is defined in the Data Model section.

### Agent Key Provisioning

The keypair held by the agent's tooling is provisioned outside the AC2 wire protocol using one of the two methods defined in **Agent DID Key Origin** (Authentication section).

#### AC2 KeyRequest / KeyResponse (OPTIONAL — HD-derived provisioning only)

`ac2/KeyRequest` and `ac2/KeyResponse` are **OPTIONAL** messages. They are used only when (a) the Controller chooses HD-derived provisioning of the key held by the agent's tooling, and (b) the tooling supports receiving derived keys via AC2 rather than deriving locally.

When in use, the tooling MAY ask the Controller to derive a keypair at a specified HD path (e.g., BIP32-Ed25519 / [[ARC-52](https://github.com/algorandfoundation/ARCs/blob/main/ARCs/arc-0052.md)]) and deliver the resulting derived private key over AC2. `KeyRequest` MUST NOT be used for independently-generated keys and MUST NEVER be used to request the Controller's root key or any non-derived key.

Origin and destination: the **agent's tooling** originates the request; the agent runtime forwards it over AC2 as a message. The matching response is routed by the plugin directly into the tooling — it MUST NOT be placed in the agent runtime's LLM-visible context.

**KeyRequest** (tooling → Controller, via the agent over AC2):

```json
{
  "@context": ["https://ac2.io/v1"],
  "type": "ac2/KeyRequest",
  "from": "did:example:agent",
  "to": ["did:example:user"],
  "body": {
    "key_type": "ed25519" | "secp256k1" | "falcon-512",
    "derivationPath": "m/44'/283'/1'/0/0",
    "purpose": "<WHY_NEEDED>",
    "for_operation": "<WHAT_OPERATION>"
  }
}
```

**KeyResponse** (Controller → tooling, via the agent over AC2):

```json
{
  "@context": ["https://ac2.io/v1"],
  "type": "ac2/KeyResponse",
  "from": "did:example:user",
  "to": ["did:example:agent"],
  "body": {
    "status": "approved" | "rejected",
    "derivationPath": "m/44'/283'/1'/0/0",
    "key_type": "ed25519",
    "material": "<BASE64_OR_ENCRYPTED_KEY_PAYLOAD>",
    "public_key": "<BASE64_PUBLIC_KEY>",
    "reason": "<OPTIONAL_REJECTION_REASON>"
  }
}
```

**Normative constraints**:

1. **Scope**: `KeyRequest` MUST only be used for HD-derived provisioning of a key to be installed in the agent's tooling. It MUST NOT be used to request the Controller's root key, an existing signing key, or any key not produced by fresh derivation at the requested path.
2. **Confidentiality**: `material` in `KeyResponse` carries a private key. The AC2 transport (Liquid Auth WebRTC DTLS) provides the channel encryption. Implementations SHOULD additionally wrap `material` in an application-layer encryption keyed to the specific tooling (e.g., a session-bound symmetric key negotiated between Controller and tooling).
3. **Runtime isolation**: The AC2 plugin MUST route `KeyResponse` directly to the tooling without placing `material` in the agent runtime's conversational context, logs, or memory. The agent runtime MUST NOT observe `material`.
4. **Single-shot**: A `KeyResponse` delivers the derived key exactly once. Re-derivation requires a fresh `KeyRequest` at the same path (the Controller's seed produces the same key).
5. **User consent**: The Controller MUST explicitly approve each `KeyRequest` via their wallet or key-management tool, with clear display of `derivationPath`, `purpose`, and `for_operation`.

### Framework-Specific Configuration Examples

The markdown examples below are non-normative and show how a compliant AC2 plugin may declare its behavior through the host framework's context files. Concrete filenames vary per framework.

#### CLAUDE.md (Behavior Rules)

```markdown
# CLAUDE.md - AC2 Behavior Rules

## Signing Policy
For signing operations on the Controller's key, follow the **Signature
Request** pattern: emit `ac2/SigningRequest`, wait for
`ac2/SigningResponse`, and use only the issued single-use signature.

## Prohibitions
- MUST NOT possess, store, or observe private key material.
- MUST NOT reuse a Signature Request signature for a different request.

Extensions MAY add additional patterns and policies; consult the loaded
extensions for their rules.
```

#### MEMORY.md (Session State)

```markdown
# MEMORY.md - AC2 Session State

## Pending Signing Requests
Track active `ac2/SigningRequest` entries:
`{ request_id, operation, created_at, timeout_at }`.
Clear on response or timeout. Store no signature material.

Extensions MAY add additional state categories (e.g., capability grant
records, receipt logs).
```

#### IDENTITY.md (Agent Identity)

```markdown
# IDENTITY.md - Agent Identity

- `did` — this agent's DID
- `name` — human-readable name
- `capabilities` — AC2 capability identifiers this agent supports

Capabilities are exchanged via an AC2 discovery extension or an extension-specific discovery mechanism (e.g. an agent-card-style descriptor); core does not mandate a discovery exchange.
```

## References

### Normative References

- [[did-core](https://www.w3.org/TR/did-core/)] W3C. *Decentralized Identifiers (DIDs) v1.0*. W3C Recommendation. June 2022.
- [[did-key](https://w3c-ccg.github.io/did-method-key/)] CCG. *The did:key Method v1.0*. W3C CCG Draft.
- [[did-resolution](https://w3c-ccg.github.io/did-resolution/)] CCG. *DID Resolution v1.0*. W3C CCG Draft.
- [[well-known-did-configuration](https://identity.foundation/.well-known/resources/did-configuration/)] DIF. *Well-Known DID Configuration*. DIF Spec.
- [[webauthn-2](https://www.w3.org/TR/webauthn-2/)] W3C. *Web Authentication: An API for accessing Public Key Credentials Level 2*. W3C Recommendation.
- [[didcomm-messaging](https://identity.foundation/didcomm-messaging/spec/)] DIF. *DIDComm Messaging Specification v2.0*. DIF Ratified Specification.
- [[RFC2119](https://www.rfc-editor.org/rfc/rfc2119)] Bradner, S. *Key words for use in RFCs to Indicate Requirement Levels*. RFC 2119.
- [[RFC4122](https://www.rfc-editor.org/rfc/rfc4122)] Leach, P., Mealling, M., Salz, R. *A Universally Unique IDentifier (UUID) URN Namespace*. RFC 4122.
- [[RFC6455](https://www.rfc-editor.org/rfc/rfc6455)] Fette, I., Melnikov, A. *The WebSocket Protocol*. RFC 6455.
- [[RFC8174](https://www.rfc-editor.org/rfc/rfc8174)] Leiba, B. *Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words*. RFC 8174.

### Informative References

- [[caip-10](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-10.md)] CASA. *CAIP-10: Account ID Specification*. (chain-agnostic account identifier format)
- [[x402](https://x402.org)] x402 Protocol. *Cross-Platform Payment Standard*.
- [[mpp-httpauth-payment](https://datatracker.ietf.org/doc/draft-ietf-httpauth-payment/)] Moxey, J. *The "Payment" HTTP Authentication Scheme*. IETF Draft. (Machine Payment Protocol — defines the `charge` and `session` intents framework)
- [[mpp-algorand-charge](https://datatracker.ietf.org/doc/)] Ghiasi, M. *Algorand Charge Intent for HTTP Payment Authentication (draft-algorand-charge)*. Independent Submission. (MPP `charge` intent — one-off payments on Algorand)
- [[mpp-algorand-session](https://datatracker.ietf.org/doc/)] Ghiasi, M. *Algorand Session Intent for HTTP Payment Authentication (draft-algorand-session)*. Independent Submission. (MPP `session` intent — metered / streaming payments on Algorand)
- [[a2a](https://github.com/google/A2A)] Google. *Agent2Agent Protocol*.
- [[mcp](https://github.com/modelcontextprotocol)] Anthropic. *Model Context Protocol*.
- [[ows](https://openwallet.sh/)] *Open Wallet Standard (OWS)*. GitHub: [open-wallet-standard](https://github.com/open-wallet-standard).
- [[liquid-auth](https://github.com/algorandfoundation/liquid-auth)] Algorand Foundation. *Liquid Auth - Open Source P2P Authentication Service*.
- [[webrtc](https://www.w3.org/TR/webrtc/)] W3C. *WebRTC: Real-Time Communication Between Browsers*.
- [[fido2](https://fidoalliance.org/specs/fido-v2.0-ps-20190130/fido-client-to-authenticator-protocol-v2.0-ps-20190130.html)] FIDO Alliance. *Client to Authenticator Protocol (CTAP)*.
- [[twingate](https://www.twingate.com/docs/how-twingate-works)] Twingate. *How Twingate Works - P2P Network Architecture*.

---

Copyright © 2026 Algorand Foundation. This specification is licensed under the [W3C Software and Document License](https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document).
