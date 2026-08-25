---
name: ac2-memory
description: 'Session-state guidance for an AC2-conformant agent. Defines what MAY and MUST NOT be retained across turns and across reconnects on the `ac2-v1` channel.'
metadata:
  {
    'openclaw':
      {
        'emoji': '🧠',
        'requires': { 'config': ['plugins.entries.ac2.enabled'] },
      },
  }
---

# MEMORY.md — AC2 Session State

This document tells the agent **what state it may carry across turns** and
**what it MUST never retain**. It is normative.

Keywords MUST / MUST NOT / SHOULD / MAY follow BCP 14 (RFC 2119 / RFC 8174).

## 1. State the Agent MAY Retain

### 1.1 Pending Signing Requests

Track active outgoing `ac2/SigningRequest` envelopes:

```
{
  request_id:   "<envelope.id>",
  thid:         "<envelope.thid>",
  operation:    "<short label, e.g. 'sign-in', 'x402-charge'>",
  description:  "<the human-readable description shown to the user>",
  created_at:   <unix-seconds>,
  expires_at:   <unix-seconds>,
  status:       "pending" | "signed" | "rejected" | "expired"
}
```

- Entries MUST be cleared when:
  - `ac2/SigningResponse` arrives → transition to `signed`, then drop after
    the signature has been consumed.
  - `ac2/SigningRejected` arrives → transition to `rejected`, then drop.
  - `expires_at` is reached without a response → transition to `expired`.
- The agent MUST NOT retain the `signature`, `public_key`, or `payload`
  bytes beyond the turn in which they are used.

### 1.2 Connection / Conversation Metadata

A single OpenClaw instance MAY hold multiple AC2 connections (one per paired
wallet, keyed by Liquid Auth `requestId`); each connection MAY host multiple
conversation threads (keyed by envelope `thid`). The agent MAY retain, per
`(connection, thid)`:

- The agent's own `did:key` granted on that connection (public material only).
- The Controller's `did:key` for that connection.
- Conversation history (chat messages) — but see §3 redactions.
- A short, human-readable summary of recent signing activity (operation name
  - outcome only — never signatures or payloads).

### 1.3 Capability Cache

The agent MAY cache the result of `ac2_capabilities` for the **current turn**
to avoid duplicate calls. The cache MUST be invalidated on:

- Channel disconnect / reconnect.
- A new turn (a fresh user message arriving).
- Any signing tool result that reports `no_active_session` or `no_identity`.

## 2. State the Agent MUST NOT Retain

The following MUST NEVER be written to memory, logs, conversation context,
LLM message history, telemetry, or any other persistent or in-process store:

1. **Private key material** in any form — raw, base64, encrypted, hashed,
   or "redacted but recoverable". The agent has no legitimate reason to see
   it; see `SOUL.md` §2.
2. **`ac2/KeyResponse.material`** — even though the protocol allows the
   tooling to receive a derived key over AC2, the AC2 plugin MUST route it
   directly to the tooling. The agent runtime MUST NOT observe it.
3. **Mnemonics, seed phrases, or BIP39 wordlists** pasted by the user.
   If the user attempts to share one, the agent MUST refuse and explain why.
4. **Signatures beyond their single use.** Once a signature has been applied
   to the operation it was issued for, the agent MUST drop it. Reusing a
   signature is a protocol violation (see SPEC §Communication Patterns).
5. **Raw `payload` bytes** beyond the lifetime of the matching request, except
   as part of a redacted audit summary that names the operation but not the
   bytes.
6. **The Controller's WebAuthn challenge, attestation, or assertion blobs.**
   These are transport-level and the agent never needs to retain them.

## 3. Redaction Rules for Conversation History

When the agent's conversation history is persisted (per `thid`), the
following redactions MUST be applied before write:

- Any base64 string that arrived inside a `body.signature`,
  `body.public_key` (only the _private_ counterpart, never the public key
  itself — public keys are safe), `body.payload`, or `body.material` field
  MUST be replaced with a placeholder like `[redacted: <field-name>]`.
- The operation `description` and outcome (`signed` / `rejected` / `expired`)
  MAY be retained for audit and continuity.

## 4. Reconnect Behavior

When a wallet reconnects to the same connection (same Liquid Auth
`requestId`):

- The agent identity key granted on that connection is reused; the agent
  MUST NOT re-prompt for identity issuance.
- Per-`thid` conversation history MUST be restored (subject to §3 redactions).
- Any `pending` `SigningRequest` whose `expires_at` has passed during the
  disconnect MUST be transitioned to `expired` on reconnect, not silently
  resumed.

## 5. Extensions

Extensions MAY define additional state categories (e.g. capability-grant
records, spend receipts, voucher counters). Extension state MUST follow the
same rules: no private key material, ever. Extensions MUST NOT weaken §2.
