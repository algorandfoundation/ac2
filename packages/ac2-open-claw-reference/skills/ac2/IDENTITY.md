---
name: ac2-identity
description: 'Compliance declaration for an AC2-conformant agent. Names the DIDs, key types, and capability identifiers this agent presents on the `ac2-v1` channel, per AC2 SPEC §Authentication and §Capability Identifier Namespacing.'
metadata:
  {
    'openclaw':
      {
        'emoji': '🪪',
        'requires': { 'config': ['plugins.entries.ac2.enabled'] },
      },
  }
---

# IDENTITY.md — AC2 Agent Identity Declaration

This document is the agent's **compliance declaration**. It MUST be consistent
with the runtime values surfaced by `ac2_capabilities`. Where this file and
`ac2_capabilities` disagree, **`ac2_capabilities` is authoritative** — this
file documents _what the agent declares it conforms to_, not the live session
state.

Keywords MUST / MUST NOT / SHOULD / MAY follow BCP 14 (RFC 2119 / RFC 8174).

## 1. Identity Fields

The agent presents itself via these fields, populated at runtime by
`ac2_capabilities`:

| Field           | Source                                   | Meaning                                                                                                                 |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `did`           | `ac2_capabilities.agent.did`             | The agent's own `did:key`, issued by the Controller's wallet during pairing. The agent signs its envelopes as this DID. |
| `name`          | `ac2_capabilities.agent.plugin.id`       | Human-readable plugin identifier (`ac2`).                                                           |
| `version`       | `ac2_capabilities.agent.plugin.version`  | Plugin semver.                                                                                                          |
| `controllerDid` | `ac2_capabilities.session.controllerDid` | The Controller account currently paired (NOT part of the agent's identity — it identifies the _peer_).                  |

The agent MUST NOT report a hard-coded placeholder DID (e.g. the legacy
`did:key:zAc2Controller`). If `agent.did` is `null`, the agent MUST report
"no identity granted yet" and follow the no-identity flow described in
`SOUL.md`.

## 2. DID Methods

Per AC2 SPEC §DID-Based Identity:

- The agent's DID MUST be a `did:key` (REQUIRED method).
- The agent MAY additionally be discoverable via `did:web` and
  `.well-known/did-configuration.json`. The reference plugin does not publish
  a `did:web` document.

## 3. Key Types

- **Ed25519** — REQUIRED. Used for the agent's identity key (issued by the
  wallet during pairing) and for `raw-ed25519` signing.
- **secp256k1** — OPTIONAL. Supported when the connected wallet exposes a
  `raw-secp256k1` signer.

The agent itself NEVER holds private key material for either curve; see
`SOUL.md` §2.

## 4. Capability Identifiers

Per AC2 SPEC §Capability Identifier Namespacing (three-tier convention):

### Core capabilities (`ac2/<name>`)

| Identifier | Surface                                                     |
| ---------- | ----------------------------------------------------------- |
| `ac2/sign` | Signature Request pattern, exposed via the `ac2_sign` tool. |

### Extension capabilities (`ac2-ext-<extension>/<capability>`)

| Identifier            | Surface                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `ac2-ext-x402/fetch`  | x402 exact Algorand paid HTTP fetch via the `ac2_x402_fetch` tool.      |

Downstream wallet plugins MAY add chain-specific `sig_hint`s (e.g.
`message-algorand`, `transaction-evm`). When such a plugin is loaded, prefer
its richer capabilities tool.

### Application capabilities (`<reverse-domain>/<name>`)

None declared.

## 5. `sig_hint` Catalog (this reference)

| `sig_hint`      | `key_type` | Operation                                       |
| --------------- | ---------- | ----------------------------------------------- |
| `raw-ed25519`   | `account` or `identity` | Ed25519 signature over the raw payload bytes.   |
| `raw-secp256k1` | `account` or `identity` | secp256k1 signature over the raw payload bytes. |

This is the **protocol catalog**. The connected wallet MAY support a subset.
Live support is reported in `ac2_capabilities.agent.sigHintsCatalog`.

## 6. Conformance Statement

This agent declares conformance to:

- AC2 Core (this SPEC), specifically:
  - §Architecture Overview — Communication Patterns (Signature Request)
  - §Data Model — `ac2/SigningRequest` / `ac2/SigningResponse` /
    `ac2/SigningRejected`
  - §WebRTC DataChannel Transport — channel label `ac2-v1`, `ordered: true`,
    one AC2 message per DataChannel frame
  - §Authentication — `did:key`, Ed25519 REQUIRED, secp256k1 OPTIONAL
  - §Agent Configuration for Digital Signatures — Core Principle

This agent does NOT implement:

- `ac2/KeyRequest` / `ac2/KeyResponse` (OPTIONAL; HD-derived provisioning is
  out of scope for the reference plugin).
- Any AC2 extension (discovery, pre-authorized operations, A2A).

## 7. Discovery

Core does NOT mandate capability discovery exchange. Peers MAY assume signing-
trio support. When a discovery extension is loaded, this agent will advertise
the capability identifiers in §4 via DIDComm `discover-features/2.0`.
