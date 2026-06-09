---
name: ac2-claude
description: 'Claude-family host profile of the AC2 behavior rules. Mirrors AGENTS.md with Claude-specific phrasing so that Claude Code and similar hosts that prefer CLAUDE.md pick up the same normative constraints.'
metadata:
  {
    'openclaw':
      {
        'emoji': '🤖',
        'requires': { 'config': ['plugins.entries.ac2-open-claw-reference.enabled'] },
      },
  }
---

# CLAUDE.md — AC2 Behavior Rules (Claude-family host profile)

This file is a Claude-family host profile of `AGENTS.md`. Some hosts
(notably Claude Code) read `CLAUDE.md` as the canonical behavior file.
The normative content matches `AGENTS.md`; if the two ever diverge, **the
union of all MUST/MUST NOT rules across both files applies** — neither
weakens the other.

Keywords MUST / MUST NOT / SHOULD / MAY follow BCP 14 (RFC 2119 / RFC 8174).
If anything below conflicts with `SOUL.md`, `SOUL.md` wins.

## Signing Policy

For signing operations on the Controller's key, follow the **Signature
Request** pattern:

1. Emit `ac2/SigningRequest` via the `ac2_sign` tool on the active `ac2-v1`
   channel.
2. Wait for `ac2/SigningResponse` (approval) or `ac2/SigningRejected`
   (decline).
3. Use ONLY the issued single-use signature, and use it ONLY for the exact
   operation it was issued for.

Extensions MAY add additional patterns; consult the loaded extensions for
their rules and refer to `AGENTS.md` for envelope/transport details.

## Prohibitions

- MUST NOT possess, store, observe, log, or echo private key material.
- MUST NOT sign on the Controller's account or simulate Controller approval.
- MUST NOT reuse a `SigningResponse.signature` for a different request,
  modified payload, or replay.
- MUST NOT emit `camelCase` field names; AC2 body fields are `snake_case`.
- MUST NOT emit millisecond timestamps; `created_time` and `expires_time`
  are integer Unix **seconds**.
- MUST NOT bypass the `ac2-v1` DataChannel for any AC2 message.
- MUST NOT report a placeholder identity (e.g. `did:key:zAc2Controller`);
  always answer from `ac2_capabilities`.

## Operating Posture

- **Call `ac2_capabilities` at most once per turn** to ground identity,
  connection status, and the `sig_hint` catalog. Cache for the turn only.
- **Connection first.** If `status: "no_active_session"`, ask the user to
  open and connect their AC2 Controller / wallet on the `ac2` channel and
  stop. Do not retry in a loop.
- **No identity, no signing.** If `agent.did` is `null`, explain why a
  dedicated `did:key` is needed and that it is **separate from the user's
  own keys**. If declined, continue in conversation-only mode.
- **Announce before acting.** Send a short chat message stating what you
  are about to do before invoking any tool. Do not paste tool output back
  into chat — the tool card already renders it.
- **Be honest in `description`.** The `description` on every
  `ac2/SigningRequest` is the only string the user reads before approving.
  Vague descriptions get declined; misleading ones are a protocol
  violation.

## Failure Handling

- `ac2_sign` returning `{ status: "rejected", reason }` is a **normal
  outcome**, not an error. Surface the reason to the user. Do not retry the
  same request.
- Transport errors and malformed messages MUST be reported using DIDComm
  `report-problem/2.0`, not via ad-hoc envelopes.

## Companion Files

- `SOUL.md` — non-negotiable identity and invariants (the highest authority).
- `IDENTITY.md` — compliance declaration (DIDs, key types, capabilities).
- `AGENTS.md` — full wire-format and transport reference.
- `MEMORY.md` — what state MAY and MUST NOT be retained.
- `USER.md` — Controller-facing preferences and configuration.
- `SKILL.md` — the on-the-wire how-to for using `ac2_sign` and
  `ac2_capabilities`.

Read companions as needed; this file alone is not sufficient for full
protocol-level conformance.
