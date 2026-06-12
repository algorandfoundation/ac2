# `@algorandfoundation/ac2-open-claw-reference`

Reference [OpenClaw](https://docs.openclaw.ai/) plugin for the **AC2**
protocol. It implements both the tool and channel interfaces — `ac2_sign`
/ `ac2_capabilities` tools plus the `ac2` channel — over Liquid Auth +
WebRTC via [`@algorandfoundation/ac2-sdk`](../ac2-sdk).

## What AC2 contributes to OpenClaw

| OpenClaw surface        | AC2 contribution                                                           |
| ----------------------- | -------------------------------------------------------------------------- |
| Channel `ac2`           | Owns Liquid Auth + WebRTC pairing and the active session.                  |
| Tool `ac2_capabilities` | Agent DID + `sig_hint` catalog.                                            |
| Tool `ac2_sign`         | Routes a `SigningRequest` to the wallet over the active channel.           |
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
- A C/C++ toolchain (the plugin pulls in native addons —
  `node-datachannel`, `@napi-rs/keyring` — that are rebuilt against your
  Node version at install time)

### Install the plugin into OpenClaw

From this monorepo (recommended while the package is pre-release):

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
`${OPENCLAW_HOME:-~/.openclaw}/extensions/ac2-open-claw-reference`, then
runs `npm rebuild` inside that directory to produce the native
`.node` binaries (`openclaw plugins install` invokes
`npm install --ignore-scripts`, so the native build scripts have to be
re-triggered manually — `install:plugin` does it for you).

To uninstall:

```bash
pnpm uninstall:plugin                                 # openclaw plugins uninstall ac2-open-claw-reference
```

> **Native rebuild caveat.** If you install the published tarball
> directly via `openclaw plugins install @algorandfoundation/ac2-open-claw-reference`
> (without the `install:plugin` wrapper), you will need to run the
> rebuild step yourself before the plugin can register — otherwise the
> gateway will fail with `Cannot find module '.../node_datachannel.node'`:
>
> ```bash
> npm rebuild --prefix "${OPENCLAW_HOME:-$HOME/.openclaw}/extensions/ac2-open-claw-reference" \
>   node-datachannel @napi-rs/keyring
> openclaw plugins enable ac2-open-claw-reference
> openclaw gateway restart
> ```

### Configuration

Once installed, `openclaw.json` will contain an entry like:

```json5
{
  'ac2-open-claw-reference': {
    enabled: true,
    config: {
      liquidAuthServer: 'https://debug.liquidauth.com',
      defaultTimeoutMs: 120000,
    },
  },
}
```

`AC2_LIQUID_AUTH_SERVER` overrides `liquidAuthServer` at runtime.

### Using it

In a conversation, enable the `ac2` channel, scan the QR with your AC2
Controller / wallet, then the model can call `ac2_capabilities`
followed by `ac2_sign`. See
[DISCOVERY §3.2](https://github.com/algorandfoundation/ac2-sdk) for the
request/response shapes.

## Scope

- ✅ Liquid Auth pairing, AC2 signing trio, `thid`-bound responses,
  channel-owned sessions, wallet-issued agent identity.
- ❌ Chain-specific verifiers, wallet introspection, holding user keys,
  a bundled Node WebRTC stack — these belong in downstream plugins.
