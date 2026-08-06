# `@algorandfoundation/ac2-cli`

The **AC2 service**: a background process that holds one connection to a mobile
wallet, plus the `ac2` command line that manages it.

Pair your wallet once, and any AC2-aware agent on the machine can ask that wallet
to sign, without ever handling your keys. The service keeps the connection alive,
reconnects it, and stores keys in your operating system's keychain.

## Install

```sh
npm install -g @algorandfoundation/ac2-cli
```

Using it with OpenClaw? Install both:

```sh
npm install -g openclaw @algorandfoundation/ac2-cli
```

While AC2 is in pre-release, add the canary tag: `npm install -g
@algorandfoundation/ac2-cli@next`.

To try it without installing anything:

```sh
npx @algorandfoundation/ac2-cli@next --help
```

Requirements: Node.js 22 or newer, and an OS keychain (macOS Keychain, Linux
Secret Service such as `gnome-keyring`, or Windows Credential Manager).

### Platform support

macOS, Linux and Windows are all supported, with these differences:

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Control channel | Unix socket in `AC2_HOME` | Unix socket in `AC2_HOME` | named pipe (`\\.\pipe\ac2-daemon`, suffixed per custom `AC2_HOME`) |
| Key storage | dedicated AC2 keychain (see Troubleshooting) | Secret Service (`gnome-keyring`, …) | Credential Manager |
| `ac2 service install` | launchd agent (runs `AC2.app`, so macOS names it "AC2") | systemd user unit | not available — use `ac2 service start`, which survives the terminal |

## Quick start

```sh
ac2 service start     # start the background service
ac2 pair              # print a QR code, then scan it with your wallet
ac2 status            # check the connection
```

That is the whole happy path. Approve the pairing on your phone and `ac2 status`
reports the connected wallet.

The service keeps running after you close the terminal. It reconnects the wallet
on its own, and after a restart it waits for the same wallet to come back with no
new scan required.

## Commands

### Service lifecycle

| Command | What it does |
| --- | --- |
| `ac2 service start` | Start the service in the background. Add `--foreground` to block instead. |
| `ac2 service stop` | Stop it. |
| `ac2 service status` | Show service and connection status. Exits 1 when not running. |
| `ac2 service attach` | Follow the live log. Ctrl+C detaches and leaves the service running. |
| `ac2 service logs [-n 50]` | Print the last N log lines. |
| `ac2 service install` | Install an OS supervision unit (systemd user service, or launchd agent on macOS) so the service starts with your session. |
| `ac2 service uninstall` | Remove that unit (and, on macOS, the launcher it generated). |

`attach` and `logs` give you the "reattach to a running session" feel of `screen`
without the service ever depending on a terminal.

### Wallet and connections

| Command | What it does |
| --- | --- |
| `ac2 pair` | Render a pairing QR code and wait for a wallet. Starts the service if it is not running. |
| `ac2 status` | Live connection snapshot, service DID, active runtime, registered agents. |
| `ac2 connections` | List remembered wallet connections. |
| `ac2 forget [--all \| --id <requestId>]` | Forget a connection and the agent identities that belong to it. |

`ac2 pair` also works while a wallet is already connected: it reports the live
session and shows the invitation the service keeps armed, so you always have
something scannable, and it never restarts a working connection.

## Using it with OpenClaw

Install the OpenClaw plugin
([`@algorandfoundation/ac2-open-claw-reference`](../ac2-open-claw-reference)) and
run `openclaw ac2 pair`. It starts this service for you and configures it to drive
your OpenClaw agent, so you do not have to set anything else up.

## Configuration

Everything has a working default. Set these only if you need to.

| Variable | Purpose |
| --- | --- |
| `AC2_HOME` | Runtime directory for the socket, log and pidfile (default `~/.ac2`). |
| `AC2_STATE_DIR` | Where connections, identities and keystore metadata are persisted (default `~/.openclaw`). |
| `AC2_DAEMON_SOCKET` | Control socket path, or Windows named pipe. Defaults to `$AC2_HOME/ac2d.sock`, and on Windows to `\\.\pipe\ac2-daemon` (plus a digest of `AC2_HOME` when that is set, so profiles never share a pipe). |
| `AC2_LIQUID_AUTH_SERVER` | Liquid Auth signaling server URL. |
| `AC2_DEFAULT_AGENT` | Agent id inbound wallet traffic goes to (default `openclaw`). |
| `AC2_HEARTBEAT_TIMEOUT_MS` | How long a silent wallet channel may stay open. |
| `AC2_RUNTIME` | Which runtime adapter drives the agent: `socket` (default), `openclaw-gateway`, or an npm package name. |
| `AC2_RUNTIME_CONFIG` | JSON config handed to that adapter. |
| `AC2_WAIT_FOR_RUNTIME` | Set to `0` to await a wallet even when no agent runtime is alive. |
| `AC2_KEYRING` | macOS only. Set to `login` to store keys in the login keychain instead of the dedicated AC2 keychain (see Troubleshooting). |
| `OPENCLAW_GATEWAY_URL` / `_PORT` / `_TOKEN` | Gateway connection for the `openclaw-gateway` adapter. Discovered from `openclaw.json` when unset. |

Set them in the environment of the process that runs the service, for example
before `ac2 service start`.

`ac2 service install` **captures** them: a supervised service inherits nothing
from your shell, so every variable above that is set at install time is written
into the unit (and echoed back as `environment captured: …`). Change one and
re-run `ac2 service install`. The unit is written mode `0600`, because it can
contain `OPENCLAW_GATEWAY_TOKEN` or a token inside `AC2_RUNTIME_CONFIG`.

On macOS the install also generates `$AC2_HOME/AC2.app`: a launcher whose only
job is to start the service under the name **AC2**. See Troubleshooting below.

## Troubleshooting

**`ac2 status` says `idle (waiting for a runtime before awaiting a wallet)`.**
The service will not await a wallet until an agent runtime is alive, so a
returning wallet is never connected to a service with nothing behind it. Start
your agent, or select the right runtime adapter. With OpenClaw that means running
`openclaw ac2 pair`, which selects the gateway adapter for you.

**The wallet paired, but nothing is routed and the status says locked.** An agent
stays bound to the first wallet that issued it an identity. Run `ac2 forget`
before pairing a different wallet.

**Nothing happens after a scan.** Check `ac2 service logs`. Pairing goes through
the Liquid Auth signaling server, so both the phone and this machine need to reach
it.

**`ac2` prints nothing at all after installing.** A bug in `1.0.0-canary.2` and
earlier: the command detected "was I run directly?" by comparing paths in a way
that never matched the `node_modules/.bin/ac2` symlink npm, pnpm and `npx`
install (and never matched on Windows at all), so it exited silently with status
0. Upgrade — `npm install -g @algorandfoundation/ac2-cli@next`.

**A supervised service ignores `AC2_STATE_DIR`.** Fixed: the units written by
`ac2 service install` used to forward `AC2_HOME` only, so the state directory
(keystore, identities, connections) silently fell back to `~/.openclaw`. Re-run
`ac2 service install` with your variables exported and restart the service; the
install now prints which variables it captured.

**`ac2 status` says the daemon is not running while it clearly is.** Also fixed:
status used to consult only the pidfile, which just the daemon started by `ac2
service start` writes — one supervised by launchd/systemd writes none. Liveness
now comes from the live control socket, with the pidfile as fallback, and
`ac2 service start` reports an already-running service instead of spawning a
second one.

**macOS asks whether "node" may run in the background.** That prompt (and the
entry in System Settings → General → Login Items & Extensions) *is* the AC2
service: macOS names a background item after the program its launchd job runs,
which used to be the bare `node` binary. `ac2 service install` now generates a
small launcher, `$AC2_HOME/AC2.app`, and points the job at it, so the item shows
up as **AC2** instead. The launcher only `exec`s the same `node … service run`
command, is ad-hoc code signed as `com.algorandfoundation.ac2`, and is deleted by
`ac2 service uninstall`.

macOS remembers the old entry, so to relabel an existing install:

```sh
launchctl unload ~/Library/LaunchAgents/com.algorandfoundation.ac2.plist
ac2 service uninstall
ac2 service install
launchctl load ~/Library/LaunchAgents/com.algorandfoundation.ac2.plist
```

Do not delete `AC2.app` on its own — the service will not start until you re-run
`ac2 service install`.

**Keychain errors on Linux.** The service stores secrets in the Secret Service
API, which needs a running keyring daemon (for example `gnome-keyring`) and an
unlocked login keyring.

**`User interaction is not allowed` on macOS.** The login keychain is locked for
background processes (launchd, SSH, before login), so macOS cannot prompt to
unlock it. The service therefore keeps its keys in a **dedicated keychain** in
the state directory (`ac2-keystore.keychain-db`, password in the `0600` file
`ac2-keystore.keychain-key` next to it) that it creates and unlocks itself — no
prompt, works headless. Entries stored in the login keychain by older versions
are migrated over on first read. Set `AC2_KEYRING=login` to opt back into the
login keychain.

## Learn more

- [ARCHITECTURE.md](./ARCHITECTURE.md): how the service, identities, keystore and
  runtime adapters fit together.
- [PROTOCOL.md](./PROTOCOL.md): the local control socket API, for building an
  agent, a tool or your own client.
- [`@algorandfoundation/ac2-sdk`](../ac2-sdk): the protocol SDK, including the
  runtime-adapter contract.
- [The AC2 specification](https://github.com/algorandfoundation/ac2/blob/master/ac2.md).
