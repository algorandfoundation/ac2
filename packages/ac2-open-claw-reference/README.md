# `@algorandfoundation/ac2-open-claw-reference`

Reference [OpenClaw](https://docs.openclaw.ai/) plugin for the **AC2**
protocol. It implements both the tool and channel interfaces — `ac2_sign`,
`ac2_capabilities`, and `ac2_x402_fetch` tools plus the `ac2` channel — over
Liquid Auth + WebRTC via [`@algorandfoundation/ac2-sdk`](../ac2-sdk).

## What AC2 contributes to OpenClaw

| OpenClaw surface        | AC2 contribution                                                           |
| ----------------------- | -------------------------------------------------------------------------- |
| Channel `ac2`           | Owns Liquid Auth + WebRTC pairing and the active session.                  |
| Tool `ac2_capabilities` | Agent DID, connected wallet address, and `sig_hint` catalog.              |
| Tool `ac2_sign`         | Routes a `SigningRequest` and returns signature details to the agent.      |
| Tool `ac2_x402_fetch`   | Pays x402 exact Algorand resources using wallet-approved AC2 signing.      |
| Setup entry             | `openclaw ac2 setup` writes the channel/tools wiring into `openclaw.json`. |

**Channels own the lifecycle; tools are pure consumers.** The `ac2`
channel pairs once (one QR per session) and registers the transport on a
`SessionManager`. `ac2_sign` reads from that manager and rejects with
`no_active_session` when no channel is connected. The agent's own
identity key is **issued by the wallet** during pairing (bootstrap
`KeyRequest`) and persisted in an OS-keychain-protected keystore — the
agent never touches the user's account keys or passkeys.

## Getting started

### Prerequisites

- Node.js ≥ 22, pnpm ≥ 10
- `openclaw` CLI on `PATH`
- `openclaw` already set up with an agent
- The plugin uses the `@napi-rs/keyring` native addon (OS keystore) that may
  need to be rebuilt against your local Node version. The WebRTC transport
  (`@roamhq/wrtc`) ships prebuilt binaries and needs no rebuild.

### Install the plugin into OpenClaw

#### From the npm registry (canary)

```bash
openclaw plugins install npm:@algorandfoundation/ac2-open-claw-reference@1.0.0-canary.21

# openclaw plugins install runs `npm install --ignore-scripts`, so the
# @napi-rs/keyring native addon is not built automatically. Rebuild it from
# the plugin project dir (@roamhq/wrtc ships prebuilt and needs no rebuild):
PLUGIN_DIR="$(ls -d "${OPENCLAW_HOME:-$HOME/.openclaw}"/npm/projects/algorandfoundation-ac2-open-claw-reference-* | head -n1)"

npm rebuild --prefix "$PLUGIN_DIR" @napi-rs/keyring

openclaw plugins enable ac2
openclaw ac2 setup                                    # wire channel + tools into openclaw.json
openclaw ac2 status
openclaw gateway restart
```

The npm-registry install lays the plugin out at
`${OPENCLAW_HOME:-~/.openclaw}/npm/projects/algorandfoundation-ac2-open-claw-reference-<hash>/node_modules/@algorandfoundation/ac2-open-claw-reference`,
so `npm rebuild --prefix` must point at the **project root** (the
`npm/projects/<slug>/` directory), not at the inner package — that's
where the rebuildable `node_modules/` tree lives.

#### From this monorepo (pre-release / development)

```bash
git clone https://github.com/algorandfoundation/ac2.git
cd ac2
pnpm install                                          # once, at the repo root

cd packages/ac2-open-claw-reference
pnpm install:plugin                                   # build → pack → openclaw plugins install → rebuild natives → enable
openclaw ac2 setup                                    # wire channel + tools into openclaw.json
openclaw gateway restart
```

`pnpm install:plugin` builds the flat tree-shakeable `dist/`, packs a
tarball with workspace-only devDependencies stripped, installs it into
`${OPENCLAW_HOME:-~/.openclaw}/extensions/ac2`, rebuilds the native
`@napi-rs/keyring` addon via `npm rebuild`, and
enables the plugin.

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
it defaults to `50000`.

### Using it

In a conversation, enable the `ac2` channel, scan the QR with your AC2
Controller / wallet, then the model can call `ac2_capabilities`
followed by `ac2_sign` for raw signing or `ac2_x402_fetch` for paid HTTP
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

The wallet approval prompt intentionally stays human-readable: it names
the paid resource, amount, network, and a compact recipient/sender summary.
The underlying signing request still uses raw Ed25519 over Algorand
transaction signing bytes (`TX`-prefixed bytes), with x402 payment and
payload metadata available in the technical request details.

## Scope

- ✅ Liquid Auth pairing, AC2 signing trio, `thid`-bound responses,
  channel-owned sessions, wallet-issued agent identity, x402 exact Algorand
  paid fetch via wallet-approved signing.
- ❌ Chain-specific verifiers, wallet introspection, holding user keys,
  a bundled Node WebRTC stack — these belong in downstream plugins.
