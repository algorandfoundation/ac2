---
name: ac2
description: "How to use the AC2 channel to ask the user's connected wallet to sign bytes over a live WebRTC link. Use this whenever the user asks you to 'sign', 'approve', or 'authorize' something with their wallet — even if they don't say 'AC2'. The agent never holds keys; the wallet does."
metadata:
  {
    'openclaw':
      {
        'emoji': '🔐',
        'requires': { 'config': ['plugins.entries.ac2-open-claw-reference.enabled'] },
      },
  }
---

# AC2 — remote wallet signing (core reference)

AC2 connects you to the **user's wallet** over a live WebRTC data channel hosted by the `ac2` channel. The user is the human on the other end. The wallet is the key custodian: **you never see or hold private keys.** You ask the wallet to sign; the user approves each request in-wallet, then the signature comes back to you.

This is the **upstream reference** plugin. It exposes only the core methods AC2 itself defines:

- one channel: `ac2`
- two tools: `ac2_capabilities`, `ac2_sign`

Chain-specific verifier tools (`ac2_verify_*`) and richer wallet introspection live in downstream wallet plugins. If you have them available, prefer them. If you don't, this skill is enough.

## The connection comes first

`ac2_sign` cannot pair on its own. It runs through the `ac2` channel's already-paired DataChannel and rejects with `{ status: "rejected", reason: "no_active_session" }` if no channel is connected. If you see that result:

1. Tell the user to open and connect their AC2 Controller / wallet on the `ac2` channel.
2. Do **not** retry in a loop. Stop and wait for the user.

## Discover first: `ac2_capabilities`

**Call `ac2_capabilities` once at the start of every new conversation** to see whether a wallet is connected and which `sig_hint`s the protocol catalogs.

The tool returns:

- `status` — `"ok"` if the channel is connected, `"no_active_session"` otherwise.
- `agent.did` — **your own identity**: the agent's `did:key` (the `from` on every AC2 envelope you send). This is derived from the identity public key the wallet granted you during pairing. When the user asks "what is your DID / identity / did:key", answer with this value.
- `agent.plugin` — `{ id, version }` of this plugin.
- `agent.sigHintsCatalog` — the protocol catalog of sig_hints AC2 defines. This is **not** a list of what the connected wallet actually supports; it's the universe of valid `sig_hint` strings. Pick from this list when calling `ac2_sign`.
- `session.connected` — boolean mirror of `status`.
- `session.controllerDid` — the **connected account**: the `did:key` of the wallet account that paired with you (taken from the Liquid Auth link response, not a hard-coded placeholder). This is who is on the other end; use it when the user asks which account/wallet is connected.

## Knowing your identity

You have two distinct `did:key` identities in every session, both surfaced by `ac2_capabilities`:

- **Your identity** (`agent.did`) — the DID bound to the identity key the user's wallet issued you. It is _yours_; you sign and present yourself as this DID. You never hold its private key — the wallet does — but this DID is who you are on the AC2 channel.
- **The connected account** (`session.controllerDid`) — the user's wallet account that is paired with you right now.

When the user asks about "your identity", "your DID", "your did:key", or "who am I connected to", call `ac2_capabilities` (if you haven't already this turn) and answer from these fields rather than guessing or inventing a value. Never report a placeholder like `did:key:zAc2Controller` — that was a legacy hard-coded value; the real connected account is in `session.controllerDid`.

If a downstream wallet plugin is loaded alongside this one, prefer its richer capabilities tool — it will report the wallet's actual identities and accounts, which lets you pick a `sig_hint` you know the wallet can fulfil instead of guessing from the catalog.

## When you have no identity — explain why you need one

The wallet grants you a dedicated identity during pairing. If it hasn't (the user declined or hasn't approved the identity request yet), you are connected for **conversation only**: `ac2_capabilities` returns `agent.did: null`, and `ac2_sign` rejects with `{ status: "rejected", reason: "no_identity" }`.

When that happens, **do not silently fail or keep retrying.** Explain yourself to the user in plain language:

- What you need: your own dedicated `did:key` identity, which their wallet issues to you.
- Why you need it: it lets you prove who you are on this channel and sign your own messages, so the user can trust messages are really from you.
- That it is **separate from their own keys/accounts** — you never see or use the user's personal keys; the identity is a distinct key minted just for you.
- What it unlocks: until an identity is granted you can still chat, but you cannot perform signing-related actions.
- The next step: ask them to approve the identity request in their wallet when they're ready.

Keep it short, honest, and reassuring — the user is deciding whether to trust you with a dedicated key, so make the purpose and the separation-from-their-keys clear. If they decline, respect it and continue the conversation without pressing.

## Connections and conversations

A single OpenClaw instance can hold **multiple connections** over time — one per paired wallet, each identified by the Liquid Auth `requestId`. OpenClaw persists that `requestId`, so a wallet can renegotiate (reconnect to) the _same_ connection later; the agent identity key granted on that connection is persisted with it and reused on reconnect (no re-prompt).

Each connection can host **multiple independent conversations**, multiplexed over the same channel and keyed by the AC2 envelope `thid` (thread id). The plugin keeps a separate agent session and persisted message history per `thid`, so a wallet that reconnects to a connection always recovers the chat history for each of its conversation threads. Frames with no `thid` map to the `default` thread (legacy single-thread controllers keep working).

Operators can inspect this with the `ac2 connections` command, which lists every known connection, its agent key metadata (agent/controller DID, public key, whether private material is held), and its conversation threads with message counts. `ac2 status` summarises the active connection and how many connections are known.

## Tell the user what you're about to do

The AC2 channel is a **conversation surface**, not a coding session. The user only sees your chat messages; tool calls and command output are surfaced separately as compact "tool cards" that render the command and its output on their own.

Concretely:

- Before you run a command or use a tool, send a short, plain-language chat message saying **what you're about to do and why** ("Let me run the test suite", "I'll update `config.ts` to enable logging").
- The tool/exec output is already displayed to the user in its own tool card, so you **don't** need to summarise or paste it back. Let the card speak for itself.
- You can still follow up with anything you need to about the tool execution — ask a clarifying question, note a next step, or react to a result — whenever it's genuinely useful to the conversation.
- Keep replies conversational and concise. This is a chat with a person, not a build log.

## The core loop: sign

1. Call **`ac2_sign`** with the bytes to sign, a human-readable `description`, and an explicit `sig_hint`.
2. The wallet shows the user an approval modal; they pick the account/identity and confirm.
3. On approval you get back a base64 `signature` plus the signer's `publicKey` (and optionally `address`/`keyType`).
4. On decline you get `{ status: "rejected", reason }` — treat that as a **normal outcome**, not an error. Tell the user what was declined.

## `sig_hint` catalog (what the core reference defines)

`sig_hint` selects the curve the wallet uses. **Always set it explicitly.** Omitting it falls back to plain Ed25519 over raw bytes.

| `sig_hint`      | `key_type` | Use                                            |
| --------------- | ---------- | ---------------------------------------------- |
| `raw-ed25519`   | `identity` | Ed25519 signature over the raw payload bytes   |
| `raw-secp256k1` | `identity` | secp256k1 signature over the raw payload bytes |

`key_type` defaults to `account`; use `identity` for DID-bound keys that never custody funds (sign-in, attestations, mandates).

> This is the **core reference**: it intentionally exposes only raw curve operations and is chain-agnostic. Downstream wallet plugins extend the `sig_hint` set with chain-specific envelopes (signed messages, typed data, transactions). If the user's wallet can't produce the requested hint, `ac2_sign` returns `{ status: "rejected" }` — tell the user what was declined rather than retrying with the same hint.

## Payloads

- `payload_base64` is the **raw** bytes that will be signed as-is under the selected curve. The core reference applies no prefix or envelope.
- `display_hint` (`text` | `json` | `hex`) only controls how the wallet's modal _renders_ the payload — no cryptographic effect.

## `description` — the only thing the user reads

The `description` is the only string the user sees before approving. Make it specific and honest:

- ✅ `"Sign in to BankApp as alice@example.com"`
- ✅ `"Authorize device 'laptop-7' for project foo"`
- ✅ `"Issue an AP2 payment mandate for $20/mo"`
- ❌ `"sign this"` — gets declined.

## Expiry

Set `expiresInSeconds` on requests that should not be honoured if the user takes too long to approve. The wallet MUST reject responses received after that window.
