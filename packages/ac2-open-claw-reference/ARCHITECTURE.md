# How the AC2 OpenClaw plugin works

Background for people who want to understand or extend the plugin. For install
and usage instructions see the [README](./README.md).

## The plugin is a client of the AC2 service

The plugin does not own the wallet connection. The
[AC2 service](../ac2-cli/README.md) does: pairing, controller binding, the
agent's identity bootstrap, key storage and reconnect all live there. The plugin
talks to it over the service's local control socket
(`@algorandfoundation/ac2-cli/control`) and mirrors the connection into its own
`SessionManager` so the tools and the `ac2` channel can use it.

```
mobile wallet ──► AC2 service ──(gateway WS/RPC)──► OpenClaw gateway ──► agent
                      ▲                                                    │
                      └────────── control socket ◄─── plugin tools ────────┘
                                 (sign, capabilities, x402)
```

What each piece contributes:

| OpenClaw surface | AC2 contribution |
| --- | --- |
| Channel `ac2` | A delivery route, so the host can push messages toward the wallet. |
| Tool `ac2_capabilities` | Agent DID, connected wallet address and signing-hint catalog, read from the service. |
| Tool `ac2_sign` | Brokers a signing request through the service and returns the signature details. |
| Tool `ac2_x402_fetch` | Pays x402 Algorand resources; payer address and every signature come from the service. |
| `openclaw ac2 setup` | Writes the channel and tool wiring into `openclaw.json`. |

### Why the tools query the service

Tools run inside the agent or gateway process, which has no pairing session of
its own. All three therefore ask the service over the control socket whenever
this process has no live session, which is the normal case.

`ac2_sign` builds an `ac2/SigningRequest` and hands it to the service's
verb-agnostic `agent.request` method. The service performs the full round-trip on
the wallet transport it owns, and fills the request's `from` and `to` from the
session's authoritative identity. The wallet's reply arrives on the service's own
client, so an in-process client could never complete the round-trip itself.

`ac2_x402_fetch` uses the same path twice: it resolves the payer address from the
live connection (the wallet address the service reports, otherwise the address
derived from the controller DID), then brokers each Algorand payment signature
through `agent.request`.

Each tool still prefers a live in-process session when one exists, for example
inside an `openclaw ac2 pair` shell, and reports "not connected" only when
neither a local session nor a reachable service is available.

The agent's own identity key is issued by the wallet during the service's
bootstrap and stored in an OS-keychain-protected keystore. Neither the plugin nor
the agent ever touches your account keys or passkeys.

### First-controller lock

The agent registers to the first wallet that grants it an identity and stays
bound to it. If a different wallet connects later, for example because the mobile
app was reinstalled with a new account key, the takeover is refused: no identity
is reused and none is regenerated. The connection is locked, no messages are
routed to the agent, and the wallet is shown a notice explaining that the operator
must clear the agent's keys first (`openclaw ac2 forget`). The service makes this
decision; the plugin only renders the notice.

## Runs happen in the service, over the gateway adapter

The plugin does not drive turns in-process. The service ships a built-in
`openclaw-gateway` runtime adapter that drives the OpenClaw agent over the gateway
WebSocket/RPC and pushes replies straight to the wallet. While that adapter is
active, the service delivers inbound wallet messages exclusively to it and never
broadcasts them back to the plugin, so there is nothing left for the plugin to
route.

`openclaw ac2 pair` commits new pairings to that adapter: just before dialling the
service it sets `AC2_RUNTIME=openclaw-gateway` in its own environment, unless the
operator already set `AC2_RUNTIME`. Because auto-start spawns the service with the
plugin's inherited environment, a freshly started service picks the adapter up
automatically. The gateway connection itself
(`OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_PORT` / `OPENCLAW_GATEWAY_TOKEN`, or
auto-discovery from `openclaw.json`) is resolved entirely by the service. The
plugin has no gateway configuration of its own.

Two consequences worth knowing:

- **It only applies to a freshly started service.** Auto-start does nothing when a
  service is already running, so an existing one keeps the adapter it started
  with. When upgrading, run `ac2 service stop` and then `openclaw ac2 pair`.
- **To roll back**, set `AC2_RUNTIME=socket` before the service starts. That
  adapter expects a control-socket agent to drive runs, which this plugin no
  longer does.

## Command behaviour

- `openclaw ac2 pair` connects to the service, auto-starting it if needed, then
  streams the QR the service emits and holds the shell open while the pairing is
  pending. It never re-pairs locally, because the service owns reconnect. When a
  wallet is **already linked** it exits early instead: it prints the live session
  (controller and agent DIDs, wallet address, and the invitation the service keeps
  armed) and returns, since there is nothing to wait for and the connection
  survives without this process.
- `openclaw ac2 status`, `connections` and `forget` are read-only service queries.
  They never auto-start the service; if it is not running they say so.
- `openclaw ac2 setup` only writes configuration.

## x402 payments

`ac2_x402_fetch` performs the x402 negotiation: it reads the `402` challenge,
asks the wallet to approve the Algorand payment transaction over AC2, retries with
the payment signature, and returns the HTTP result.

Network ids are compared canonically. CAIP-2 caps a chain reference at 32
characters, so `@x402/avm` canonicalises Algorand to
`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`, while live resources still advertise
the full 44-character genesis hash
(`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`). Both spellings name the
same chain, so the allowlist, the network preferences and the registered payment
schemes all pass through one canonicaliser. Without it a valid Algorand offer is
refused with `No network/scheme registered for x402 version: 2 which comply with
the payment requirements`. Accepting both spellings does not widen the allowlist:
a chain that is not allowed is still refused.

The wallet approval prompt stays human-readable. It names the paid resource, the
amount, the network and a compact sender/recipient summary. The underlying
request still signs raw Ed25519 over Algorand transaction signing bytes
(`TX`-prefixed), with payment metadata available in the technical details.

## Scope

- **In scope:** the AC2 signing tools, thread-bound responses, service-backed
  sessions, wallet-issued agent identity, and x402 Algorand paid fetch through
  wallet-approved signing.
- **Not here:** owning the wallet connection. Liquid Auth pairing, controller
  binding, identity and key persistence, reconnect and the Node WebRTC stack all
  live in [`@algorandfoundation/ac2-cli`](../ac2-cli).
- **Not here either:** chain-specific verifiers, wallet introspection, or holding
  user keys. Those belong in downstream plugins.
