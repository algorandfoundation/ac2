# `@algorandfoundation/ac2-open-claw-reference`

Reference [OpenClaw](https://docs.openclaw.ai/) plugin for the **AC2**
protocol. It implements both the tool and channel interfaces — `ac2_sign`,
`ac2_capabilities`, and `ac2_x402_fetch` tools plus the `ac2` channel — on
top of the standalone **AC2 service** shipped by
[`@algorandfoundation/ac2-cli`](../ac2-cli).

## Architecture: the plugin is a client of the AC2 service

The plugin does **not** own the wallet connection. The AC2 daemon does.
It owns Liquid Auth + WebRTC pairing, controller binding, the agent's
identity bootstrap, identity/keystore persistence and reconnect; the
plugin talks to it over the daemon's NDJSON control socket
(`@algorandfoundation/ac2-cli/control`) and simply mirrors the connection
into its `SessionManager` so tools and the `ac2` channel can use it.

- `openclaw ac2 pair` connects to the daemon, **auto-starting it** if it
  is not already running, then streams the QR the daemon emits and holds
  the session open. It never re-pairs locally — the daemon owns reconnect.
- `ac2 service start|stop|status|attach|logs|install` (from the `ac2` CLI)
  manages the service lifecycle.
- `openclaw ac2 status`, `connections` and `forget` are **read-only daemon
  queries** (`daemon.status`, `connections.list`, `connections.forget`).
  They never auto-start the daemon; if it is not running they say so.

| OpenClaw surface        | AC2 contribution                                                           |
| ----------------------- | -------------------------------------------------------------------------- |
| Channel `ac2`           | Mirrors the daemon's live wallet connection as the active session.          |
| Tool `ac2_capabilities` | Agent DID, connected wallet address, and `sig_hint` catalog — read from the daemon. |
| Tool `ac2_sign`         | Brokers a `SigningRequest` through the daemon's generic `agent.request` and returns signature details. |
| Tool `ac2_x402_fetch`   | Pays x402 exact Algorand resources; payer address and every transaction signature are resolved through the daemon. |
| Setup entry             | `openclaw ac2 setup` writes the channel/tools wiring into `openclaw.json`. |

**The daemon owns the lifecycle; the plugin and its tools are pure
consumers.** The daemon — not this plugin — owns the wallet connection, so
**all three tools** query the **daemon** over the control socket when this
process has no live pairing session (the norm in the agent/gateway process
where tools actually run). `ac2_sign` in particular
builds an `ac2/SigningRequest` frame and hands it to the daemon's generic,
verb-agnostic `agent.request` method, which performs the full
`SigningRequest` → `SigningResponse` round-trip on the wallet transport it
owns and fills the request's `from`/`to` from the session's authoritative
identity; the wallet's response arrives on the daemon's own client, so an
in-process client could never complete the round-trip. `ac2_x402_fetch`
rides the same path twice: it resolves the **payer address** from the live
connection's facts (the wallet address the daemon reports, else the address
derived from the controller DID) and then brokers *each* Algorand payment
signature through `agent.request`, so paid fetches work with no local
pairing session at all. Every tool still prefers a live in-process
`SessionManager` session when one exists (e.g. an `openclaw ac2 pair`
shell), and reports "not connected" / `no_active_session` only when neither
a local session nor a reachable daemon is available. The
agent's own identity key is **issued by the wallet** during the daemon's
bootstrap (`KeyRequest`) and persisted by the daemon in an
OS-keychain-protected keystore — neither the plugin nor the agent ever
touches the user's account keys or passkeys.

**First-controller lock.** The agent registers to the **first** wallet
(controller) that grants it an identity and stays bound to it. If a
*different* wallet later connects — e.g. because the mobile app flushed
its keystore and now presents a brand-new account key — the agent refuses
the takeover: it will **not** reuse the bound identity or regenerate a
fresh one for the new wallet. The connection is locked (no messages are
routed to the agent) and the wallet is shown a `notice` banner explaining
that the operator must clear the agent's keys — run `openclaw ac2 forget`
(or delete the agent state under `~/.openclaw`) — before a new wallet can
register and be issued a fresh identity. `ac2 status` reports the lock.
This decision is made by the daemon; the plugin only renders the resulting
`notice`.

### Runs happen in the daemon, over the `openclaw-gateway` adapter

The plugin does not drive turns in-process. The AC2 daemon ships a
built-in `openclaw-gateway` runtime adapter that drives the OpenClaw agent
over the gateway WS/RPC itself and pushes replies straight to the wallet
(`host.send` → `broker.send`). When that adapter is active, the daemon
delivers every inbound wallet message **exclusively** to it and never
broadcasts it back out to this plugin's control-socket session — so there
is nothing left for the plugin to route.

`openclaw ac2 pair` commits new pairings to that adapter: right before it
dials the daemon it sets `AC2_RUNTIME=openclaw-gateway` in its own process
environment *if the operator hasn't already set `AC2_RUNTIME`*. Since
`connectAgentSession`/`ensureDaemonRunning` auto-start the daemon by
spawning `ac2 service run` with the plugin's inherited environment, a
freshly auto-started daemon picks up `AC2_RUNTIME=openclaw-gateway`
automatically. The gateway connection itself (`OPENCLAW_GATEWAY_URL` /
`OPENCLAW_GATEWAY_PORT` / `OPENCLAW_GATEWAY_TOKEN`) is resolved entirely by
the daemon's adapter from its own inherited environment/defaults — the
plugin has no gateway configuration of its own.

> **Caveat:** this only takes effect on a *freshly auto-started* daemon.
> Auto-start only spawns a new daemon process when none is already running,
> so an **already-running** daemon keeps whatever adapter it was started
> with. If you're upgrading an existing install, stop the daemon first
> (`ac2 service stop`) and re-run `openclaw ac2 pair` so the newly spawned
> daemon picks up the gateway adapter.

To roll back to the legacy `socket` adapter (which relies on a
control-socket agent client, such as this plugin's now-removed in-process
routing, to drive runs), set `AC2_RUNTIME=socket` in the environment before
the daemon starts.

## Getting started

### Prerequisites

- Node.js ≥ 22, pnpm ≥ 10
- `openclaw` CLI on `PATH`
- `openclaw` already set up with an agent
- The AC2 service (`@algorandfoundation/ac2-cli`, the `ac2` binary) reachable
  on `PATH`. It owns the connection stack, so the native WebRTC
  (`@roamhq/wrtc`) and keychain (`@napi-rs/keyring`) dependencies belong to
  the service, not to this plugin.

### Install the plugin into OpenClaw

#### From the npm registry (canary)

```bash
openclaw plugins install @algorandfoundation/ac2-open-claw-reference@next
openclaw plugins enable ac2
openclaw ac2 setup                                    # wire channel + tools into openclaw.json
openclaw ac2 status
openclaw gateway restart
```

Keep the `@next` tag in the install command and do not add `--pin`. OpenClaw
records that moving npm spec, which lets both the normal OpenClaw updater and
the plugin-only updater discover newer AC2 canary releases.

Use `@next` while testing canary releases published from `master`. The
unversioned package and `@latest` both follow stable releases published from
the `release` branch, so they do not receive new canary builds.

The npm-registry install lays the plugin and its dependencies out in
OpenClaw's managed npm-project directory under the active state directory.

#### From this monorepo (pre-release / development)

```bash
git clone https://github.com/algorandfoundation/ac2.git
cd ac2
pnpm install                                          # once, at the repo root

cd packages/ac2-open-claw-reference
pnpm install:plugin                                   # build → pack → openclaw plugins install → enable
openclaw ac2 setup                                    # wire channel + tools into openclaw.json
openclaw gateway restart
```

`pnpm install:plugin` builds the flat tree-shakeable `dist/`, packs a
tarball with workspace-only devDependencies stripped, installs it into
`${OPENCLAW_HOME:-~/.openclaw}/extensions/ac2`, and enables the plugin.
There is no native rebuild step any more: the keystore and the WebRTC stack
moved to the AC2 service, which is installed and rebuilt separately (see
`ac2 service install`).

### Update the plugin

An npm install made with the moving `@next` tag is updated automatically when
you update OpenClaw:

```bash
openclaw update
```

To check and update AC2 without updating OpenClaw itself, run:

```bash
openclaw plugins update ac2
openclaw gateway restart
```

You can preview a plugin update with `openclaw plugins update ac2 --dry-run`.
OpenClaw reports the currently installed and available package versions.

To uninstall (either install path):

```bash
openclaw plugins uninstall ac2
# or, from the monorepo:
pnpm uninstall:plugin
```

### Configuration

Once installed, `openclaw.json` will contain an entry like:

```json5
{
  plugins: {
    entries: {
      ac2: {
        enabled: true,
      },
    },
  },
  channels: {
    ac2: {
      liquidAuthServer: 'https://debug.liquidauth.com',
    },
  },
}
```

`AC2_LIQUID_AUTH_SERVER` overrides `liquidAuthServer` at runtime.
`AC2_HEARTBEAT_TIMEOUT_MS` overrides the WebRTC heartbeat liveness timeout;
it defaults to `50000`. Both are read by the process that owns the
connection — the AC2 service — so set them in the service's environment
(`ac2 service install` / `ac2 service start`).

`AC2_RUNTIME` selects which runtime adapter the daemon drives runs with —
`openclaw-gateway` (the default `openclaw ac2 pair` commits to) or `socket`
(the legacy rollback). See
[Runs happen in the daemon, over the `openclaw-gateway` adapter](#runs-happen-in-the-daemon-over-the-openclaw-gateway-adapter)
above.

### Using it

Run `openclaw ac2 pair` (it starts the AC2 service for you), scan the QR it
prints with your AC2 Controller / wallet, then the model can call
`ac2_capabilities` followed by `ac2_sign` for raw signing or `ac2_x402_fetch` for paid HTTP
resources that advertise x402 exact payments on Algorand. `ac2_x402_fetch`
does the x402 402-response negotiation, asks the wallet to approve the
Algorand payment transaction signing over AC2, retries with
`PAYMENT-SIGNATURE`, and returns the HTTP/payment result.

For the demo weather resource, the agent should use `ac2_x402_fetch` even
when the user asks a plain weather question such as "what's the weather
like today?" and does not provide a URL. In that case the default endpoint
is:

```text
https://example.x402.goplausible.xyz/avm/weather
```

Network ids are compared canonically. CAIP-2 caps a chain reference at 32
characters, so `@x402/avm` canonicalises Algorand to
`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe` while live resources still
advertise the full 44-character genesis hash
(`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`). Both spellings name
the same chain, so the allowlist, the network preferences and the registered
payment schemes all go through one canonicaliser — otherwise a valid Algorand
offer is refused with `No network/scheme registered for x402 version: 2 which
comply with the payment requirements`. Widening the spelling does not widen the
allowlist: a chain that is not allowed is still refused.

The wallet approval prompt intentionally stays human-readable: it names
the paid resource, amount, network, and a compact recipient/sender summary.
The underlying signing request still uses raw Ed25519 over Algorand
transaction signing bytes (`TX`-prefixed bytes), with x402 payment and
payload metadata available in the technical request details.

## Scope

- ✅ AC2 signing trio, `thid`-bound responses, daemon-backed sessions,
  wallet-issued agent identity, x402 exact Algorand paid fetch via
  wallet-approved signing.
- ❌ Owning the wallet connection: Liquid Auth pairing, controller binding,
  identity/keystore persistence, reconnect and the Node WebRTC stack all
  live in `@algorandfoundation/ac2-cli`.
- ❌ Chain-specific verifiers, wallet introspection, holding user keys —
  these belong in downstream plugins.
