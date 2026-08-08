# Install `@algorandfoundation/ac2-open-claw-reference`

This guide installs the AC2 reference plugin for OpenClaw and pairs it with a
mobile wallet. It covers two pieces:

- **The plugin** (`@algorandfoundation/ac2-open-claw-reference`) — the OpenClaw
  channel, tools and `openclaw ac2` commands.
- **The AC2 service** (`@algorandfoundation/ac2-cli`) — the separate background
  process that owns the wallet connection. **The plugin cannot work without
  it**; the `ac2` binary must be on your `PATH` before you pair.

This guide is for humans. AI agents and operator automation should follow
[INSTALL-AGENT.md](./INSTALL-AGENT.md) instead.

## Requirements

- **Node.js 22 or newer.**
- **An OpenClaw agent already set up** (`npm install -g openclaw` and completed
  onboarding).
- **The `ac2` binary from `@algorandfoundation/ac2-cli` on your `PATH`** (step 1
  below installs it). The native WebRTC and keychain dependencies belong to that
  service, not to this plugin.
- **An OS keychain** for the AC2 service to store keys in: macOS Keychain, Linux
  Secret Service (such as `gnome-keyring`), or Windows Credential Manager.

## Step 1 — Install the AC2 service (required first)

```sh
npm install -g openclaw @algorandfoundation/ac2-cli@next
```

If OpenClaw is already installed, install only the service:

```sh
npm install -g @algorandfoundation/ac2-cli@next
```

While AC2 is in pre-release, keep the `@next` (canary) tag.

## Step 2 — Install and wire the plugin

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

## Step 3 — Pair a wallet

```sh
openclaw ac2 pair
```

Scan the QR code with your AC2 controller wallet and approve. That command starts
the AC2 service if it is not already running, so this is the only step.

Running `openclaw ac2 pair` again while a wallet is connected simply prints the
live session and exits.

## Step 4 — Verify

```sh
openclaw ac2 status     # the connection as the service reports it
ac2 service status      # service + connection status; exits 1 when not running
```

After a successful pairing, `openclaw ac2 status` reports the connected wallet.
From inside a chat, `/ac2 status` shows the same status.

## Configuration

`openclaw ac2 setup` writes the plugin wiring for you; the result and the
service's environment variables are documented in the
[Configuration section of the README](./README.md#configuration). Connection
settings are read by the process that owns the connection, which is the AC2
service, so set them in its environment (before `ac2 service start`, or in the
unit written by `ac2 service install`). The full service variable list is in the
[ac2-cli README](../ac2-cli/README.md#configuration).

## Update

```sh
openclaw update                     # updates OpenClaw and @next plugins together
openclaw plugins update ac2         # AC2 only
openclaw gateway restart
```

Preview an update with `openclaw plugins update ac2 --dry-run`.

After upgrading, note that a service that was already running keeps the runtime
it started with. If turns are not running, stop and re-pair:

```sh
ac2 service stop
openclaw ac2 pair
```

## Uninstall

```sh
openclaw plugins uninstall ac2
```

To also drop the pairing and the agent identity bound to it, run
`openclaw ac2 forget` before uninstalling.

## Troubleshooting

**The tools say no wallet is connected.** Check `openclaw ac2 status`. If the
service is not running, run `openclaw ac2 pair`.

**The wallet paired but nothing reaches the agent.** The agent may be bound to a
different wallet (see the first-controller lock in
[ARCHITECTURE.md](./ARCHITECTURE.md)). Run `openclaw ac2 forget`, then pair again.

**You upgraded and turns are not running.** A service that was already running
keeps the runtime it started with. Run `ac2 service stop`, then
`openclaw ac2 pair`.

For service-level issues (pairing never completes, keychain errors, runtime
status), see the
[Troubleshooting section of the ac2-cli README](../ac2-cli/README.md#troubleshooting).
