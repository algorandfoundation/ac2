# `@algorandfoundation/ac2-open-claw-reference`

The reference [OpenClaw](https://docs.openclaw.ai/) plugin for **AC2**. It lets
your OpenClaw agent chat with a mobile wallet and ask that wallet to sign things,
while you keep custody of your keys.

You get three agent tools and one channel — see [Tools](#tools).

The wallet connection itself is owned by the separate
[AC2 service](../ac2-cli/README.md), which this plugin starts for you.

## Quick start

> **Prerequisite:** the plugin needs the `ac2` binary from
> [`@algorandfoundation/ac2-cli`](../ac2-cli/README.md) on your `PATH` — the
> first command below installs it. The native WebRTC and keychain dependencies
> belong to that service, not to this plugin. You also need Node.js 22 or newer
> and an OpenClaw agent already set up.

```sh
npm install -g openclaw @algorandfoundation/ac2-cli@next

openclaw plugins install @algorandfoundation/ac2-open-claw-reference@next
openclaw plugins enable ac2
openclaw ac2 setup          # writes the channel + tools into openclaw.json
openclaw gateway restart

openclaw ac2 pair           # print a QR code
```

Scan the QR code with your AC2 controller wallet and approve. `openclaw ac2 pair`
starts the AC2 service if it is not already running, so this is the only step.

For requirements, the reason behind the `@next` tag, updating, uninstalling and
troubleshooting, see [INSTALL.md](./INSTALL.md). AI agents and operator
automation should follow [INSTALL-AGENT.md](./INSTALL-AGENT.md) instead.

## How it works

The plugin does not own the wallet connection. The
[AC2 service](../ac2-cli/README.md) does: pairing, controller binding, the
agent's identity bootstrap, key storage and reconnect all live there. The plugin
talks to it over the service's local control socket.

```
mobile wallet ──► AC2 service ──(gateway WS/RPC)──► OpenClaw gateway ──► agent
                      ▲                                                    │
                      └────────── control socket ◄─── plugin tools ────────┘
                                 (sign, capabilities, x402)
```

Once a wallet is paired:

- Message your agent from the wallet app and the reply comes back to your phone,
  including tool activity and sub-agent progress. Runs happen in the service,
  which drives the OpenClaw agent over the gateway WebSocket/RPC and pushes
  replies straight to the wallet.
- The agent can call `ac2_capabilities` to see the connection, `ac2_sign` to ask
  you to sign a payload, and `ac2_x402_fetch` for paid resources.
- Running `openclaw ac2 pair` again while a wallet is connected simply prints the
  live session and exits.

The full model — why the tools query the service, the first-controller lock, the
runtime adapter, the x402 details — is in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Tools

Once installed, the agent gets three tools and one channel:

| Tool or channel | What it gives the agent |
| --- | --- |
| `ac2_capabilities` | Agent DID, connected wallet address and signing-hint catalog, read from the service. |
| `ac2_sign` | Brokers a signing request through the service and returns the signature details. |
| `ac2_x402_fetch` | Pays x402 Algorand resources; payer address and every signature come from the service. |
| Channel `ac2` | A delivery route, so the host can push messages toward the wallet. |

### Paid fetches

`ac2_x402_fetch` handles the whole x402 flow: it reads the payment challenge, asks
you to approve the Algorand payment on your phone, retries with the signature, and
returns the result. For the demo weather resource the agent should use this tool
even for a plain question like "what's the weather like today?", with the default
endpoint:

```text
https://example.x402.goplausible.xyz/avm/weather
```

### Commands

| Command | What it does |
| --- | --- |
| `openclaw ac2 pair` | Pair a wallet (starts the AC2 service if needed). |
| `openclaw ac2 status` | Show the connection as the service reports it. |
| `openclaw ac2 connections` | List remembered wallet connections. |
| `openclaw ac2 forget` | Drop a pairing and the agent identity bound to it. |
| `openclaw ac2 setup` | Write or refresh the plugin's `openclaw.json` wiring. |
| `/ac2 status` | The same status from inside a chat. |

Everything except `pair` and `setup` is read-only and never starts the service.

## Configuration

`openclaw ac2 setup` writes the wiring for you. The result looks like this:

```json5
{
  plugins: { entries: { ac2: { enabled: true } } },
  channels: { ac2: { liquidAuthServer: 'https://debug.liquidauth.com' } },
}
```

Connection settings are read by the process that owns the connection, which is the
AC2 service, so set them in its environment (before `ac2 service start`, or in the
unit written by `ac2 service install`):

| Variable | Purpose |
| --- | --- |
| `AC2_LIQUID_AUTH_SERVER` | Overrides `liquidAuthServer`. |
| `AC2_HEARTBEAT_TIMEOUT_MS` | Wallet channel liveness timeout (default `50000`). |
| `AC2_RUNTIME` | Which runtime drives agent turns. `openclaw ac2 pair` selects `openclaw-gateway`; `socket` is the rollback. |

## Data flow and privacy

- **Your account keys and passkeys never leave your wallet.** Neither the plugin
  nor the agent ever touches them. The agent requests signatures; you review and
  approve on your phone, and only the resulting signature is delegated back.
- **The agent's own identity key** is issued by the wallet during the service's
  bootstrap and stored in an OS-keychain-protected keystore.
- **Pairing goes through the Liquid Auth signaling server** (set by
  `liquidAuthServer` / `AC2_LIQUID_AUTH_SERVER`), so both the phone and this
  machine need to reach it. The wallet channel itself is an authenticated
  peer-to-peer WebRTC DataChannel, end-to-end encrypted, with no centralized
  message relay server.
- **Connection state is persisted by the AC2 service, not the plugin:**
  connections, identities and keystore metadata live in its state directory
  (`AC2_STATE_DIR`, default `~/.openclaw`), with secrets in the OS keychain.
- **The agent stays bound to the first wallet that issued it an identity**
  (first-controller lock). A different wallet cannot silently take over the
  agent; the operator must clear the agent's keys first with
  `openclaw ac2 forget`.

## Verify

```sh
openclaw ac2 status     # the connection as the service reports it
ac2 service status      # service + connection status; exits 1 when not running
```

After a successful pairing, `openclaw ac2 status` reports the connected wallet.
From inside a chat, `/ac2 status` shows the same status. If something looks
wrong, `ac2 service logs -n 50` prints the last log lines — see
[Troubleshooting in INSTALL.md](./INSTALL.md#troubleshooting).

## Documentation

| Document | What it covers |
| --- | --- |
| [INSTALL.md](./INSTALL.md) | Step-by-step install, requirements, update, uninstall, troubleshooting. |
| [INSTALL-AGENT.md](./INSTALL-AGENT.md) | Deterministic install guide for AI agents and operator automation. |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | How the plugin, the AC2 service and the OpenClaw gateway divide the work, plus the x402 and identity details. |
| [`@algorandfoundation/ac2-cli`](../ac2-cli/README.md) | The AC2 service and `ac2` CLI. |
| [ac2-cli ARCHITECTURE.md](../ac2-cli/ARCHITECTURE.md) | How the service, identities, keystore and runtime adapters fit together. |
| [ac2-cli PROTOCOL.md](../ac2-cli/PROTOCOL.md) | The local control socket API, for building an agent, a tool or your own client. |
| [`@algorandfoundation/ac2-sdk`](../ac2-sdk/README.md) | The protocol SDK. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Developing in this monorepo. |
| [ac2.md](../../ac2.md) | The AC2 protocol specification. |
