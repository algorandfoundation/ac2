# `@algorandfoundation/ac2-open-claw-reference`

Reference [OpenClaw](https://docs.openclaw.ai/) plugin for the **AC2**
protocol. It implements both the tool and channel interfaces — `ac2_sign`,
`ac2_capabilities`, `ac2_x402_fetch`, and `ac2_git_sign` tools plus the `ac2`
channel — over Liquid Auth + WebRTC via
[`@algorandfoundation/ac2-sdk`](../ac2-sdk).

## What AC2 contributes to OpenClaw

| OpenClaw surface        | AC2 contribution                                                           |
| ----------------------- | -------------------------------------------------------------------------- |
| Channel `ac2`           | Owns Liquid Auth + WebRTC pairing and the active session.                  |
| Tool `ac2_capabilities` | Agent DID, connected wallet address, and `sig_hint` catalog.              |
| Tool `ac2_sign`         | Routes a `SigningRequest` and returns signature details to the agent.      |
| Tool `ac2_x402_fetch`   | Pays x402 exact Algorand resources using wallet-approved AC2 signing.      |
| Tool `ac2_git_sign`     | Produces a git-compatible SSHSIG signature approved by the wallet.         |
| Setup entry             | `openclaw ac2 setup` writes the channel/tools wiring into `openclaw.json`. |

**Channels own the lifecycle; tools are pure consumers.** The `ac2`
channel pairs once (one QR per session) and registers the transport on a
`SessionManager`. `ac2_sign` reads from that manager and rejects with
`no_active_session` when no channel is connected. The agent's own
identity key is **issued by the wallet** during pairing (bootstrap
`KeyRequest`) and persisted in an OS-keychain-protected keystore — the
agent never touches the user's account keys or passkeys.

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

## Getting started

### Prerequisites

- Node.js ≥ 22, pnpm ≥ 10
- `openclaw` CLI on `PATH`
- `openclaw` already set up with an agent
- The plugin's native dependencies (`@napi-rs/keyring` and `@roamhq/wrtc`)
  publish platform packages that OpenClaw installs automatically.

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
pnpm install:plugin                                   # build → pack → openclaw plugins install → rebuild natives → enable
openclaw ac2 setup                                    # wire channel + tools into openclaw.json
openclaw gateway restart
```

`pnpm install:plugin` builds the flat tree-shakeable `dist/`, packs a
tarball with workspace-only devDependencies stripped, installs it into
`${OPENCLAW_HOME:-~/.openclaw}/extensions/ac2`, rebuilds the native
`@napi-rs/keyring` addon via `npm rebuild`, and
enables the plugin.

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

## Git commit signing over AC2

Git can sign commits with SSH keys (`gpg.format ssh`), and an SSHSIG
signature is just a raw Ed25519 signature over a locally-constructed
blob. Since an Algorand address *is* an Ed25519 public key, the paired
wallet's account key doubles as a GitHub SSH signing key — no new key
material, no protocol changes, and the private key never leaves the
wallet.

### One-time setup

```bash
openclaw ac2 github-key     # print the wallet's key as an ssh-ed25519 line
```

Add the printed line on GitHub under **Settings → SSH and GPG keys →
New SSH key**, choosing key type **Signing Key**. Do this **before your
first signed commit**: commits are signed with the Ed25519 key on your
AC2 wallet, and GitHub marks them *Unverified* until that key is
registered. Then apply the git wiring in one shot:

```bash
openclaw ac2 git-config <repo-dir> --name <github-username> --email <email> [--pat <token>]
```

This writes the signing shim + allowed-signers file and runs the
`git config` commands in the target repo (`--global` also works;
run with no repo dir to just print the commands):

```bash
git config gpg.format ssh
git config user.signingkey 'key::ssh-ed25519 AAAA… ac2-<addr>'
git config gpg.ssh.program '<state-dir>/ac2/ac2-ssh-sign'
git config gpg.ssh.allowedSignersFile '<state-dir>/ac2/allowed_signers'
git config commit.gpgsign true
```

`--name`/`--email` set the committer identity (GitHub shows *Verified*
only when the email matches the account). `--pat` stores a fine-grained
GitHub token in a mode-0600 credential file under the AC2 state dir and
wires `credential.helper`, so `git push` over HTTPS authenticates —
signing proves authorship, but pushing still needs its own credential.

### How a commit gets signed

1. `git commit` invokes the configured `gpg.ssh.program` shim exactly
   like `ssh-keygen -Y sign`.
2. The shim forwards the commit buffer over a mode-0600 Unix socket to
   the **git-signing bridge**, which the `ac2` channel serves while a
   session is active.
3. The bridge builds the SSHSIG signed-data blob, routes a standard
   `raw-ed25519` `SigningRequest` to the paired wallet, and the user
   approves it (e.g. `Sign git commit: "feat: …"`).
4. The bridge verifies the returned signature and public key (pinned to
   the key git was configured with), assembles the armored
   `SSH SIGNATURE` block, and the shim writes it where git expects.

Signing requires an active `ac2` session (`openclaw ac2 pair`) — each
commit is a wallet approval. `ac2_git_sign` exposes the same flow as a
tool so the agent can sign arbitrary git objects with consent.

Environment overrides: `AC2_GIT_SIGN_SOCKET` (bridge socket path) and
`AC2_GIT_SIGN_TIMEOUT_MS` (shim approval timeout, default `180000`).

## Scope

- ✅ Liquid Auth pairing, AC2 signing trio, `thid`-bound responses,
  channel-owned sessions, wallet-issued agent identity, x402 exact Algorand
  paid fetch via wallet-approved signing, git/GitHub commit signing (SSHSIG)
  via the wallet's account key.
- ❌ Chain-specific verifiers, wallet introspection, holding user keys,
  a bundled Node WebRTC stack — these belong in downstream plugins.
