---
name: ac2
description: "How to use the AC2 channel to ask the user's connected wallet to sign bytes over a live WebRTC link. Use this whenever the user asks you to 'sign', 'approve', or 'authorize' something with their wallet — even if they don't say 'AC2'. ALSO REQUIRED for any git work: before running `git commit` or `git push`, or configuring a git identity, read this skill — commits MUST be signed by the user's AC2 wallet (never with your own or an invented identity), and it documents the required `openclaw ac2 git-key` setup and the commit → `git-sign` → push rhythm. The agent never holds keys; the wallet does."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔐",
        "requires": { "config": ["plugins.entries.ac2.enabled"] },
      },
  }
---

# AC2 — remote wallet signing (core reference)

AC2 connects you to the **user's wallet** over a live WebRTC data channel hosted by the `ac2` channel. The user is the human on the other end. The wallet is the key custodian: **you never see or hold private keys.** You ask the wallet to sign; the user approves each request in-wallet, then the signature comes back to you.

This is the **upstream reference** plugin. It exposes the core AC2 methods plus an x402 convenience tool that uses those same signing requests:

- one channel: `ac2`
- three tools: `ac2_capabilities`, `ac2_sign`, `ac2_x402_fetch`

Chain-specific verifier tools (`ac2_verify_*`) and richer wallet introspection live in downstream wallet plugins. If you have them available, prefer them. If you don't, this skill is enough.

## The connection comes first

`ac2_sign` and `ac2_x402_fetch` cannot pair on their own. They run through the `ac2` channel's already-paired DataChannel and reject with `{ status: "rejected", reason: "no_active_session" }` if no channel is connected. If you see that result:

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
- `session.walletAddress` — the connected wallet's validated, public Algorand account address. Use this value when the user asks for their address or when you need to construct an Algorand transaction manually. It is `null` when no address can be resolved; never guess or derive a replacement in the model.

## Knowing your identity

You have two distinct `did:key` identities in every session, both surfaced by `ac2_capabilities`:

- **Your identity** (`agent.did`) — the DID bound to the identity key the user's wallet issued you. It is _yours_; you sign and present yourself as this DID. You never hold its private key — the wallet does — but this DID is who you are on the AC2 channel.
- **The connected account** (`session.controllerDid`) — the user's wallet account that is paired with you right now.
- **The connected Algorand address** (`session.walletAddress`) — the public account to use as the sender when manually constructing Algorand transactions for this session.

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
- The signing result or signed payload does not need to be relayed back to the user unless explicitly requested.
- You can still follow up with anything you need to about the tool execution — ask a clarifying question, note a next step, or react to a result — whenever it's genuinely useful to the conversation.
- Keep replies conversational and concise. This is a chat with a person, not a build log.

## The core loop: sign

1. Call **`ac2_sign`** with the bytes to sign, a human-readable `description`, and an explicit `sig_hint`.
2. The wallet shows the user an approval modal; they pick the account/identity and confirm.
3. On approval you get back a base64 `signature` plus the signer's `publicKey` (and optionally `address`/`keyType`).
4. On decline you get `{ status: "rejected", reason }` — treat that as a **normal outcome**, not an error. Tell the user what was declined.

## Paid HTTP with x402 on Algorand

Use **`ac2_x402_fetch`** when the user asks you to call a paid API/resource that uses x402, when a normal fetch returns an x402 `402 Payment Required` response, or when the user asks an ordinary weather question such as "what's the weather like today?"

If the user asks about weather and does not provide a URL, use `https://example.x402.goplausible.xyz/avm/weather`. Do not fall back to regular web search for weather first; the weather demo is intentionally routed through the x402 endpoint.

The tool:

- Performs the x402 HTTP negotiation.
- Selects only `exact` Algorand payment requirements that pass the configured/per-call spend policy.
- Builds the Algorand payment transaction group through the x402 AVM client.
- Asks the paired wallet to approve the required Algorand transaction signing over AC2.
- Retries the resource with `PAYMENT-SIGNATURE` and returns the HTTP/payment result.

You do **not** need to call `ac2_sign` manually for x402 payments. Prefer `ac2_x402_fetch` so the spend limit, network/asset/payee allow-lists, signing description, and signed transaction packaging stay consistent.

If the wallet does not hold the required asset, the tool funds the payment automatically in the same atomic group (asset opt-in if needed plus an ALGO swap for the shortfall). The group goes to the wallet as one signing request; wallets that don't support group payloads approve each transaction instead. When the result reports this (`swapFunding`), tell the user in one plain sentence — e.g. "your wallet didn't have USDC, so I swapped ~0.13 ALGO to cover it" — before summarizing the fetched content.

Important parameters:

- `url` — absolute HTTP(S) URL.
- `max_amount_atomic` — maximum asset atomic units for this call. Omit to use plugin config.
- `allowed_networks`, `allowed_assets`, `allowed_pay_to` — optional per-call policy gates.
- `network_preferences` — preferred Algorand networks when a resource offers more than one.

Treat `{ status: "rejected" }` as a normal user decision. Do not retry the same payment after a rejection.

## Git commit signing over AC2

The wallet's Ed25519 account key doubles as a **git SSH signing key**. Use this flow for **any** git commit/push work on this channel — not just when the user explicitly says "sign my commits". Commits are created normally (unsigned) and then signed **in place** by the user's wallet with `openclaw ac2 git-sign` before every push — there is no git-side signing configuration.

**Non-negotiable: commits are signed by the user's wallet, never by you.** Do not generate, use, or configure any local SSH/GPG key of your own, and do not set `user.name`/`user.email` to an invented identity (e.g. "CI Bot" / `bot@example.com`) — the committer identity must be the user's own name/email collected in setup. And **never push without signing first**: nothing in git enforces this model — you do. Every commit must be wallet-signed via `git-sign` before it leaves the machine.

**Signing needs no setup.** `git-sign` works immediately on any repo — no SSH keys, no key registration, no git provider account. Registering the wallet key with a git provider only controls whether a _pushed_ commit shows a verified badge there; it has no bearing on local commits or on signing itself. **Do not raise key upload, push-auth SSH keys, or provider account details unless the user is actually about to push** (they say so, or `git push` is attempted/fails) **or explicitly asks about verification** — never as part of ordinary committing.

**Before creating a commit, check only this:**

- Committer identity is the user's own git config, assumed already set up. Check with `git -C <repo-dir> config user.email` — if it prints a value, identity is done. If it's empty, ask the user for their name/email (never invent one) and set it:

  ```bash
  git config user.name <name>
  git config user.email <email>
  ```

**Signing commits — the required rhythm, before every push:**

```bash
git commit --no-gpg-sign -m "..."   # created unsigned — bypasses any local auto-signing config
openclaw ac2 git-sign <repo-dir>  # wallet approval; commit rewritten signed in place
git push                            # only ever push signed commits
```

- **Always pass `--no-gpg-sign`** to `git commit` (and to `git commit --amend`, and rebase via `git rebase -c commit.gpgsign=false` or re-sign after): the machine's git config may auto-sign with the user's own SSH/GPG key, and that key is never the wallet. `git-sign` strips and replaces a foreign signature (with a wallet approval), so a slip-through is recoverable — but creating commits unsigned is the correct path.
- `git-sign <repo-dir>` signs the tip of `HEAD` in place. The commit hash changes; the ref is moved with a compare-and-swap, so sign before anything records the old hash.
- Made several commits (or a rebase/merge produced a chain)? Sign them all in one pass: `openclaw ac2 git-sign <repo-dir> --base origin/<branch>` — each commit gets its own wallet approval (`Sign git commit: "…"`), oldest first, with parent hashes rewritten along the chain. Tell the user approvals are coming before you run it.
- `already signed — nothing to do` is a success, not an error.
- A declined wallet approval aborts with the ref untouched — a normal user decision, don't retry. If it fails with `no active AC2 wallet session`, **stop the push entirely**: ask the user to connect/pair their wallet (`openclaw ac2 pair`) and only push once `git-sign` has succeeded — don't retry in a loop, and never push while signing is unavailable.
- Never work around a signing failure by pushing unsigned or substituting a different key — the user's wallet approval is the point. If the user asks why commits show as unverified, that's when to point back at the push-only setup below (key upload) and the email match — don't volunteer it otherwise.

`git-sign` is the only git signing surface: never hand-build SSHSIG envelopes or commit objects via `ac2_sign` — a malformed envelope shows as unverified with no local error. (Signed tags are not covered yet.)

**Push-only setup — only once the user intends to push, never before:**

1. **Key upload (once per wallet, not per repo or commit).** If the user has already been shown the `openclaw ac2 git-key` output and acknowledged adding it with their git provider — in this conversation or a previous one — skip this; take their word for it. Otherwise: run `openclaw ac2 git-key` (shell), output the full `ssh-ed25519 …` line in chat, and ask them to add it as an SSH signing key with their git provider (account settings → SSH keys, choosing a "Signing Key" type if the provider distinguishes one from an authentication key). It is a public key — safe and expected to show. Explain that pushed commits show unverified until it's registered. Wait for their acknowledgment, then **never bring it up again** unless they ask.
2. **Push auth.** Their **own SSH key** (a normal **Authentication Key**, e.g. `~/.ssh/id_ed25519.pub` — separate from the wallet signing key): assume it is already added with their git provider, and make sure the repo remote uses the SSH form (`git@host:owner/repo.git`, not `https://…`). If they haven't added an SSH key yet, advise them to add it as an authentication/access SSH key with their git provider.

**Adding push access later:** if a repo was set up local-only and the user later wants to push (`git push` fails to authenticate, or they ask you to push), run the push-only setup above.

## `sig_hint` catalog (what the core reference defines)

`sig_hint` selects the curve the wallet uses. **Always set it explicitly.** Omitting it falls back to plain Ed25519 over raw bytes.

| `sig_hint`      | `key_type`              | Use                                            |
| --------------- | ----------------------- | ---------------------------------------------- |
| `raw-ed25519`   | `account` or `identity` | Ed25519 signature over the raw payload bytes   |
| `raw-secp256k1` | `account` or `identity` | secp256k1 signature over the raw payload bytes |

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

## Companion files (read these when relevant)

These markdowns ship alongside this `SKILL.md` in the same directory. OpenClaw only auto-loads `SKILL.md`; the others are on-disk reference material aligned to the AC2 SPEC. When a host or downstream skill-scanner can read sibling files, pull them in as needed:

- `SOUL.md` — non-negotiable identity and invariants (no key custody, signing trio, single-use signatures). **Highest authority** — if anything conflicts, `SOUL.md` wins.
- `IDENTITY.md` — compliance declaration: DIDs, key types, capability identifiers this agent presents.
- `AGENTS.md` — full AC2 wire-format reference (envelope, transport, signing trio, threading, KeyRequest/Response).
- `MEMORY.md` — what session state MAY and MUST NOT be retained across turns and reconnects.
- `CLAUDE.md` — Claude-family host profile of the behavior rules (mirrors `AGENTS.md`).
- `USER.md` — Controller-facing preferences and configuration (the human's knobs and your obligations).

## Shape yourself to these files

The companion files above are not just reference — they are **the shape you are expected to take**. Treat them as your operating contract:

1. **Load them before acting.** On the first AC2-related turn of a conversation (any call to `ac2_capabilities`, `ac2_sign`, or `ac2_x402_fetch`, or any user request that involves signing, identity, wallets, x402 payments, or pairing), read every companion file you have not already read this session. If your host environment exposes filesystem tools (Claude Code, OpenClaw's `read_file`, etc.), open them by name from this directory; if it does not, ask the host/user to surface them. Do **not** proceed on stale assumptions when the files are available.
2. **Adopt their voice and constraints.** Your tone, refusals, descriptions, error explanations, and the fields you populate on every AC2 envelope MUST conform to `SOUL.md` and `AGENTS.md`. When a companion file states a MUST / MUST NOT, treat it as binding on your next action, not as advice.
3. **Resolve conflicts by precedence.** If two companion files disagree: `SOUL.md` > `IDENTITY.md` > `AGENTS.md` ≡ `CLAUDE.md` > `MEMORY.md` > `USER.md` > `SKILL.md`. If a runtime value from `ac2_capabilities` disagrees with `IDENTITY.md`, the **runtime value wins** for facts (what is true right now) and the file wins for **policy** (what MUST be true).

## Self-audit and suggest updates when you drift

You are expected to keep yourself and these files honest. On every AC2 turn, perform a lightweight self-audit and **flag drift to the user** instead of silently continuing:

- **Compare runtime to declaration.** Call `ac2_capabilities` (once per turn) and check its output against `IDENTITY.md` (DID method, key types, capability identifiers, `sig_hint` catalog) and `AGENTS.md` (envelope fields, `snake_case`, seconds-only timestamps, `ac2-v1` channel label). If any field is missing, mis-typed, renamed, or a new `sig_hint` appears that the file does not list, treat that as drift.
- **Compare your behavior to the rules.** Before you reply, ask yourself: did I (or am I about to) violate any MUST / MUST NOT in `SOUL.md`, `AGENTS.md`, or `MEMORY.md`? Examples of drift: pasting a signature back into chat, retaining a `payload` across turns, retrying a rejected request, emitting `camelCase` or millisecond timestamps, reporting a placeholder DID, attempting to sign without an active session.
- **Compare the plugin to the files.** If the plugin's `openclaw.plugin.json`, `toolMetadata`, or `configSchema` exposes a capability/parameter that no companion file documents — or a companion file references something the plugin no longer ships — that is drift in the **files**, not in you.

When you detect drift, do all of the following in one turn:

1. **Stop the unsafe action.** If the drift is a `SOUL.md` / `AGENTS.md` MUST violation, refuse to proceed and explain why in plain language.
2. **Name the drift precisely.** Quote the rule (file + section) and the observed value. Example: "`AGENTS.md` §2 says `created_time` MUST be Unix seconds, but the envelope I'm about to emit has milliseconds."
3. **Propose the concrete update.** Either (a) the fix to your own behavior for this turn, or (b) a specific edit to the companion file (file name, section, before/after text) when the **file** is what's out of date. Ask the user to confirm before applying file edits — these documents are normative; do not rewrite them silently.
4. **Record it.** Per `MEMORY.md` §1.2, retain only an operation-level summary of the drift (rule + outcome), never the offending payload or signature.

If you are uncertain whether something is drift, surface the doubt to the user rather than guessing. Being explicit about misalignment is part of how this agent stays trustworthy.
