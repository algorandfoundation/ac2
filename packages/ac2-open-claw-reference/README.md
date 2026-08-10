# `@algorandfoundation/ac2-open-claw-reference`

The reference [OpenClaw](https://docs.openclaw.ai/) plugin for **AC2**. It lets
your OpenClaw agent chat with a mobile wallet and ask that wallet to sign things,
while you keep custody of your keys.

You get four agent tools and one channel:

| Tool or channel | What it gives the agent |
| --- | --- |
| `ac2_capabilities` | Whether a wallet is connected, its address, and what it can sign. |
| `ac2_sign` | Ask the wallet to sign a payload; the user approves on their phone. |
| `ac2_x402_fetch` | Fetch an HTTP resource that charges with x402 on Algorand, paying with wallet approval. |
| `ac2_git_sign` | Produce a git-compatible SSHSIG signature approved by the wallet. |
| Channel `ac2` | The wallet becomes a chat channel: you message your agent from your phone. |

The wallet connection itself is owned by the separate
[AC2 service](../ac2-cli/README.md), which this plugin starts for you.

## Install

```sh
npm install -g openclaw @algorandfoundation/ac2-cli@next
```

Then add the plugin to OpenClaw:

```sh
openclaw plugins install @algorandfoundation/ac2-open-claw-reference@next
openclaw plugins enable ac2
openclaw ac2 setup          # writes the channel + tools into openclaw.json
openclaw gateway restart
```

Keep the `@next` tag and do not add `--pin`: OpenClaw records that moving spec, so
both the OpenClaw updater and the plugin-only updater can find newer AC2 canary
releases. The unversioned package and `@latest` follow stable releases and will
not pick up canaries.

You need Node.js 22 or newer, an OpenClaw agent already set up, and the `ac2`
binary from `@algorandfoundation/ac2-cli` on your `PATH`. The native WebRTC and
keychain dependencies belong to that service, not to this plugin.

## Use it

```sh
openclaw ac2 pair
```

Scan the QR code with your AC2 controller wallet and approve. That command starts
the AC2 service if it is not already running, so this is the only step.

From then on:

- Message your agent from the wallet app and the reply comes back to your phone,
  including tool activity and sub-agent progress.
- The agent can call `ac2_capabilities` to see the connection, `ac2_sign` to ask
  you to sign a payload, and `ac2_x402_fetch` for paid resources.

Running `openclaw ac2 pair` again while a wallet is connected simply prints the
live session and exits.

### Paid fetches

`ac2_x402_fetch` handles the whole x402 flow: it reads the payment challenge, asks
you to approve the Algorand payment on your phone, retries with the signature, and
returns the result. For the demo weather resource the agent should use this tool
even for a plain question like "what's the weather like today?", with the default
endpoint:

```text
https://example.x402.goplausible.xyz/avm/weather
```

## Commands

| Command | What it does |
| --- | --- |
| `openclaw ac2 pair` | Pair a wallet (starts the AC2 service if needed). |
| `openclaw ac2 status` | Show the connection as the service reports it. |
| `openclaw ac2 connections` | List remembered wallet connections. |
| `openclaw ac2 forget` | Drop a pairing and the agent identity bound to it. |
| `openclaw ac2 setup` | Write or refresh the plugin's `openclaw.json` wiring. |
| `openclaw ac2 github-key` | Print the wallet's key as a GitHub SSH signing key. |
| `openclaw ac2 git-config` | Wire git commit signing (and HTTPS push) through the AC2 wallet. |
| `/ac2 status` | The same status from inside a chat. |

Everything except `pair`, `setup`, and `git-config` is read-only and never starts
the service.

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
registered. Then set the repo's committer identity:

```bash
openclaw ac2 git-config <repo-dir> --name <github-username> --email <email> [--pat <token>]
```

`--name`/`--email` set the committer identity (GitHub shows *Verified*
only when the email matches the account). `--pat` stores a fine-grained
GitHub token in a mode-0600 credential file under the AC2 state dir and
wires `credential.helper`, so `git push` over HTTPS authenticates —
signing proves authorship, but pushing still needs its own credential.
No git signing settings are configured — signing happens after the
commit, below.

### How a commit gets signed

Commits are created unsigned and signed **in place** before push:

```bash
git commit -m "..."
openclaw ac2 git-resign <repo-dir>   # or --base origin/<branch> for a chain
git push
```

1. `git-resign` reads the exact commit payload with
   `git cat-file commit` — for an unsigned commit this is byte-for-byte
   the SSHSIG signing input.
2. It builds the SSHSIG signed-data blob and routes a standard
   `raw-ed25519` `SigningRequest` to the paired wallet; the user
   approves it (e.g. `Sign git commit: "feat: …"`).
3. It verifies the returned signature, inserts the armored
   `SSH SIGNATURE` block as the commit's `gpgsig` header, writes the new
   object with `git hash-object`, and moves the ref with a
   compare-and-swap `git update-ref`. The commit hash changes; with
   `--base`, a whole chain is re-signed oldest-first with parent hashes
   rewritten along the way.

Signing requires an active `ac2` session (`openclaw ac2 pair`) — each
commit is a wallet approval. `ac2_git_sign` exposes the same flow as a
tool so the agent can sign arbitrary git objects with consent.

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

## Update and remove

```sh
openclaw update                     # updates OpenClaw and @next plugins together
openclaw plugins update ac2         # AC2 only
openclaw gateway restart
```

Preview an update with `openclaw plugins update ac2 --dry-run`. To remove the
plugin, run `openclaw plugins uninstall ac2`.

## Troubleshooting

**The tools say no wallet is connected.** Check `openclaw ac2 status`. If the
service is not running, run `openclaw ac2 pair`.

**The wallet paired but nothing reaches the agent.** The agent may be bound to a
different wallet (see the first-controller lock in
[ARCHITECTURE.md](./ARCHITECTURE.md)). Run `openclaw ac2 forget`, then pair again.

**You upgraded and turns are not running.** A service that was already running
keeps the runtime it started with. Run `ac2 service stop`, then
`openclaw ac2 pair`.

## Learn more

- [ARCHITECTURE.md](./ARCHITECTURE.md): how the plugin, the AC2 service and the
  OpenClaw gateway divide the work, plus the x402 and identity details.
- [`@algorandfoundation/ac2-cli`](../ac2-cli): the AC2 service and `ac2` CLI.
- [`@algorandfoundation/ac2-sdk`](../ac2-sdk): the protocol SDK.
- [Developing in this monorepo](../CONTRIBUTING.md).
