---
name: ac2-user
description: "Controller-facing preferences and configuration guidance for the AC2 reference plugin. Describes the knobs the human Controller controls and the agent's obligations when honoring them."
metadata:
  {
    'openclaw':
      {
        'emoji': '🧑',
        'requires': { 'config': ['plugins.entries.ac2-open-claw-reference.enabled'] },
      },
  }
---

# USER.md — Controller Preferences & Configuration

This document names the knobs the **Controller** (the human on the other end
of the `ac2-v1` channel) controls, and the agent's obligations when honoring
them. The Controller is the source of truth for these settings; the agent
MUST surface, respect, and never override them.

Keywords MUST / MUST NOT / SHOULD / MAY follow BCP 14 (RFC 2119 / RFC 8174).

## 1. Configuration Surface (`openclaw.plugin.json`)

The plugin exposes the following configuration to the Controller:

| Key                | Type   | Default                                                             | Purpose                                                                               |
| ------------------ | ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `liquidAuthServer` | string | (env `AC2_LIQUID_AUTH_SERVER`, else `https://debug.liquidauth.com`) | Liquid Auth signaling server origin. Production deployments MUST set this explicitly. |
| `defaultTimeoutMs` | number | `120000`                                                            | Default ceiling for awaiting pairing and `SigningResponse`, in milliseconds.          |

The agent MUST treat these values as Controller preferences. It MUST NOT
mutate or persist alternative defaults beyond what the host framework
exposes.

## 2. Per-Request Preferences

For each `ac2_sign` invocation the Controller (via the agent's prompt or
the wallet UI) MAY adjust:

| Field                | Source                                   | Effect                                                                                         |
| -------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `description`        | Agent (validated by user in modal)       | The only string the user reads before approving. MUST be honest.                               |
| `sig_hint`           | Agent (from `ac2_capabilities` catalog)  | Selects the curve / envelope. MUST be explicit; omission falls back to Ed25519 over raw bytes. |
| `display_hint`       | Agent                                    | UX-only; how the wallet renders the payload preview. No cryptographic effect.                  |
| `key_type`           | Agent (`account` default, or `identity`) | Which key role the signer SHOULD use. Wallet MAY refuse.                                       |
| `expires_in_seconds` | Agent                                    | TTL after which the wallet MUST reject a late response.                                        |

The agent MUST NOT silently change a field after the Controller has reviewed
it. If a retry is needed with different fields, the agent MUST issue a new
`ac2/SigningRequest` and let the Controller review it from scratch.

## 3. Consent Model

Per AC2 SPEC §Privacy Considerations:

- The Controller's consent is **per-operation by default** — every
  `ac2/SigningRequest` is reviewed and approved (or rejected) individually.
- Bounded pre-authorization (if introduced by an extension) MUST be
  **revocable at any time**.
- The Controller MAY revoke session consent by disconnecting the `ac2-v1`
  channel; the agent MUST treat this as `no_active_session` and stop all
  signing flows.

## 4. Identity Issuance

During pairing the wallet MAY issue the agent a dedicated `did:key`
identity. This is a Controller decision:

- The Controller MAY decline. In that case the agent operates in
  conversation-only mode (`agent.did: null`); `ac2_sign` will reject with
  `reason: "no_identity"`.
- The Controller MAY revoke the identity later by removing the connection
  from the wallet. On the next pairing, a fresh identity is issued.

The agent MUST explain — clearly and once — what the identity unlocks and
that it is **separate from the Controller's own keys**. The agent MUST
NOT pressure the Controller, MUST NOT re-prompt after a decline within the
same connection, and MUST NOT fabricate an identity to "work around" the
absence of one.

## 5. Privacy Defaults

Per SPEC §Privacy Considerations / Data Minimization, the agent SHOULD:

- Not retain AC2 message bodies after the operation completes (see
  `MEMORY.md`).
- Not log unnecessary metadata (e.g. raw payloads, signatures, WebAuthn
  blobs).
- Not share AC2 session data with third parties.
- Provide the Controller (when a UI is available) with a way to inspect and
  delete persisted connection state.

The `ac2 connections` and `ac2 status` operator commands expose connection
metadata; they MUST NOT print private key material (none is held by the
agent runtime in any case).

## 6. Controller-Visible Surfaces

The Controller sees:

- **The wallet approval modal** — driven by `description`, `payload`,
  `display_hint`. The agent's words live here; make them count.
- **The chat surface** — the agent's plain-language messages. Tool output
  renders as separate tool cards; the agent MUST NOT paste them back into
  chat.
- **Operator commands** (`ac2 status`, `ac2 connections`) — inspection only.

The Controller does NOT see the agent's internal reasoning or memory. That
means the agent MUST be especially careful that anything intended for the
Controller is sent as chat, and that anything sensitive (per `MEMORY.md` §2)
never leaves the agent's runtime — not even as commentary.
