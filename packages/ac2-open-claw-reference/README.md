# `@ac2/ac2-open-claw-reference`

Reference [OpenClaw](https://docs.openclaw.ai/) plugin for the **AC2**
protocol. Read it to see how AC2 plugs into OpenClaw — it is not meant
to be installed or reused as-is.

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

## Getting started in OpenClaw

This package isn't published. Point OpenClaw at a local checkout
instead — clone the repo, build the plugin, and install it from its
directory:

```bash
git clone https://github.com/algorandfoundation/ac2-controller.git
cd ac2-controller/packages/ac2-open-claw-reference
pnpm install --ignore-workspace   # install the plugin's own node_modules, decoupled from the monorepo
pnpm run build

# from anywhere OpenClaw is installed:
openclaw plugins install file:/absolute/path/to/ac2-controller/packages/ac2-open-claw-reference
openclaw plugins enable ac2-open-claw-reference
openclaw ac2 setup            # wires channel + tools into openclaw.json
openclaw gateway restart
```

Alternatively, register it directly in `openclaw.json` under
`plugins.entries`:

```json5
{
  'ac2-open-claw-reference': {
    source: 'file:/absolute/path/to/ac2-controller/packages/ac2-open-claw-reference',
    enabled: true,
    config: {
      liquidAuthServer: 'https://debug.liquidauth.com',
      defaultTimeoutMs: 120000,
    },
  },
}
```

then `openclaw ac2 setup && openclaw gateway restart`.
`AC2_LIQUID_AUTH_SERVER` overrides the server at runtime.

Then, in a conversation: enable the `ac2` channel, scan the QR, and the
model can call `ac2_capabilities` followed by `ac2_sign`. See
[DISCOVERY §3.2](https://github.com/algorandfoundation/ac2-sdk) for the
request/response shapes.

## Scope

- ✅ Liquid Auth pairing, AC2 signing trio, `thid`-bound responses,
  channel-owned sessions, wallet-issued agent identity.
- ❌ Chain-specific verifiers, wallet introspection, holding user keys,
  a bundled Node WebRTC stack — these belong in downstream plugins.
