---
title: AC2 Pre-Authorized Operations Extension
shortname: ac2-ext-pre-authorized
status: Draft
editors:
  - Mohammad Ghiasi <emg110@goplausible.com>
extends: ac2 (Agentic Communication and Control Protocol)
created: 2026-04-22
---

## Abstract

This extension to the AC2 Protocol defines the **Pre-Authorized** communication pattern and the messages that support it, enabling agents to autonomously execute **payments and asset-transfer transactions** the Controller has granted in advance. The extension introduces two scenarios — a Controller-funded tooling account (Scenario A) and an on-chain vault (Scenario B) — and the message types needed to provision, exercise, and audit such authority.

This extension is scoped to payments and asset-transfer signing. Non-payment data signing (e.g., JWT signing, attestations) and other autonomous operations are out of scope and remain governed by core AC2 (Signature Request pattern) or other extensions.

The extension builds on AC2 core. All foundational mechanisms — agent identity, DID-based key provisioning (including HD-derived keys linked to the Controller's seed), Liquid Auth transport, DIDComm message format, the Signature Request fallback pattern, and capability discovery via `discover-features/2.0` — are defined in the core specification.

## Status of This Document

This is a Draft extension. The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are interpreted per [BCP 14](https://www.rfc-editor.org/info/bcp14).

## Discovery

A conforming implementation MUST advertise this extension via DIDComm `discover-features/2.0` using the feature identifier `ac2-ext-pre-authorized/1.0`. Peers that do not advertise this feature do not support pre-authorized operations; agents MUST fall back to the Signature Request pattern defined in core for any operation that would otherwise have used this extension.

## Communication Pattern

**Pre-Authorized (for background payments, metered streaming payments, asset transfers)**

```
[Prior]  Controller has granted bounded, revocable payment authority via:
         - Scenario A: Controller topped up an account the agent's
           tooling controls (agentic-tooling-controlled account)
         - Scenario B: Controller deposited into an on-chain vault
           bound to the agent's account with a cap + validity window

Agent:                    Invoke tooling to sign and execute the
                          payment within the pre-authorized bounds
                          (no user round-trip)

Agent ──► Controller:     Spend Receipt
                          (required for every payment)
```

## Scenarios

- **Scenario A — Agentic-tooling-controlled account.** The agent has authority over an account whose keys are held by the agent's tooling. The Controller funds this account by responding to a wallet URI exchanged over AC2. The enforcement of the cap is off-chain: the Controller tops up only what they are willing to grant.
- **Scenario B — On-chain vault.** The Controller deposits into a smart contract with a cap, validity window, and the agent's account bound as the sole authorized spender. The contract's design, methods, and on-chain enforcement are defined by a chain-specific companion specification and are out of scope for this extension.

## Asset Identification

Wherever a message in this extension carries an `amount`, it MUST be accompanied by a top-level `body` field `chain` ([[caip-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md)] identifier) and an `asset` identifying the unit (i.e., `chain` and `asset` sit alongside `amount` inside `body`, not on the DIDComm envelope itself). For native chain tokens, `asset.id` uses the chain's zero / native identifier (e.g., `"0"` for ALGO). `symbol` is display-only.

## Messages

`ac2/AgentSpendReceipt` MUST be sent by the agent for every pre-authorized payment or asset transfer.

### Agent Top-Up Request (Scenario A)

Sent by the agent to request funding of its tooling-controlled account. The `topUpUri` uses the wallet URI scheme defined for the target chain (e.g., ARC-26 for Algorand).

```json
{
  "@context": ["https://ac2.io/v1", "https://ac2.io/ext/pre-authorized/v1"],
  "type": "ac2/AgentTopUpRequest",
  "from": "did:example:agent",
  "to": ["did:example:user"],
  "created_time": 1700000000,
  "expires_time": 1700003600,
  "body": {
    "reason": "Balance below threshold for pending x402 payments",
    "chain": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    "asset": { "id": "31566704", "symbol": "USDC" },
    "currentBalance": "1500000",
    "requestedAmount": "10000000",
    "topUpUri": "algorand://AGENT_ACCOUNT_ADDRESS?amount=10000000&asset=31566704"
  }
}
```

### Agent Capability Grant (Scenario B)

Sent by the Controller to grant the agent a bounded capability backed by an on-chain vault. The `vaultPointer` is a chain-agnostic identifier (e.g., CAIP-10 style) resolvable to the vault's chain, address, and parameters. Cap, window, and state are read from the vault, not from this message.

```json
{
  "@context": ["https://ac2.io/v1", "https://ac2.io/ext/pre-authorized/v1"],
  "type": "ac2/AgentCapabilityGrant",
  "from": "did:example:user",
  "to": ["did:example:agent"],
  "created_time": 1700000000,
  "body": {
    "capabilities": ["ac2-ext-pre-authorized/mpp.charge", "ac2-ext-pre-authorized/mpp.session.voucher"],
    "vaultPointer": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=/app/987654321/vault/NTRZR6HGMMZGYMJKUNVNLKLA427ACAVIPFNC6JHA5XNBQQHW7MWA",
    "note": "LLM inference budget for April"
  }
}
```

### Agent Spend Receipt

Sent by the agent after every pre-authorized payment or asset transfer. Required.

```json
{
  "@context": ["https://ac2.io/v1", "https://ac2.io/ext/pre-authorized/v1"],
  "type": "ac2/AgentSpendReceipt",
  "from": "did:example:agent",
  "to": ["did:example:user"],
  "created_time": 1700001000,
  "body": {
    "operation": "mpp.session.voucher",
    "chain": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    "asset": { "id": "31566704", "symbol": "USDC" },
    "amount": "25000",
    "recipient": "MERCHANT_ACCOUNT_ADDRESS",
    "txid": "ALGORAND_TX_ID",
    "context": "Voucher issued for LLM inference — 1000 tokens"
  }
}
```

## Plugin State (non-normative)

A conforming plugin SHOULD track:

- Active capability grants: `{ grant_id, backing_pointer, chain, asset, cap, valid_until, revoked }`. Authoritative state lives in the backing mechanism (vault, tooling-controlled account, signing scope).
- Append-only log of emitted `ac2/AgentSpendReceipt` entries (metadata only).

## References

This extension references definitions from:

- [AC2 core: *Agentic Communication and Control Protocol*](ac2.md) — agent identity, DID-based key provisioning, Liquid Auth transport, DIDComm message format, Signature Request pattern, capability discovery.
- [[caip-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md)] CASA. *CAIP-2: Blockchain ID Specification*.
- [[caip-10](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-10.md)] CASA. *CAIP-10: Account ID Specification*.
- [[mpp-httpauth-payment](https://datatracker.ietf.org/doc/draft-ietf-httpauth-payment/)] Moxey, J. *The "Payment" HTTP Authentication Scheme*. IETF Draft.
