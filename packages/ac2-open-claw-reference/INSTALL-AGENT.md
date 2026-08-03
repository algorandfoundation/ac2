# AC2 OpenClaw Plugin — Agent Install Guide

This guide is for AI agents and operator automation. It installs
`@algorandfoundation/ac2-open-claw-reference` (the OpenClaw plugin) and
`@algorandfoundation/ac2-cli` (the AC2 service) deterministically. Humans should
read [INSTALL.md](./INSTALL.md); background is in [README.md](./README.md) and
[ARCHITECTURE.md](./ARCHITECTURE.md).

**Critical dependency:** the plugin is a client of the AC2 service. The `ac2`
binary from `@algorandfoundation/ac2-cli` must be on `PATH` before pairing can
work. Installing the plugin alone is not sufficient. Always run Step 1 checks
before anything else.

## Identity: map intent to commands

| Operator intent | Commands |
| --- | --- |
| Fresh install | Steps 1–4 below, in order. |
| Pair (or re-print pairing info) | `openclaw ac2 pair` |
| Check status | `openclaw ac2 status` (or `ac2 service status`) |
| Upgrade | `openclaw plugins update ac2` then `openclaw gateway restart` |
| Reset pairing / switch wallet | `openclaw ac2 forget`, then `openclaw ac2 pair` |
| Uninstall | `openclaw plugins uninstall ac2` |

Do not substitute other install mechanisms. The plugin is installed through
`openclaw plugins install`, and the service through `npm install -g`.

## Step 1 — Preconditions

Run these checks; resolve each failure before continuing.

| Check | Command | On failure |
| --- | --- | --- |
| Node.js ≥ 22 | `node --version` | Install Node.js 22 or newer, then re-check. |
| OpenClaw installed | `command -v openclaw` | `npm install -g openclaw` (an OpenClaw agent must already be set up/onboarded). |
| `ac2` binary on PATH | `command -v ac2` | `npm install -g @algorandfoundation/ac2-cli@next` |
| OS keychain available | — | The service stores keys in macOS Keychain, Linux Secret Service (e.g. `gnome-keyring`, running and unlocked), or Windows Credential Manager. On headless Linux, ensure a keyring daemon is running. |

`command -v ac2` failing is the most common cause of a broken install. Never
skip it.

## Step 2 — Install and wire the plugin

Run in order; each command must succeed before the next:

```sh
openclaw plugins install @algorandfoundation/ac2-open-claw-reference@next
openclaw plugins enable ac2
openclaw ac2 setup
openclaw gateway restart
```

Rules:

- Keep the `@next` tag. Do not add `--pin` (OpenClaw records the moving spec so
  updaters can find newer AC2 canary releases; `@latest` and the unversioned
  package will not pick up canaries).
- `openclaw ac2 setup` writes the channel + tool wiring into `openclaw.json`.
  It only writes configuration; it is safe to re-run.

## Step 3 — Pair a wallet

```sh
openclaw ac2 pair
```

Expected behavior (from the plugin and service docs):

- The command prints a QR code and waits. It auto-starts the AC2 service if it
  is not already running — no separate service start is needed.
- A human must scan the QR code with their AC2 controller wallet and approve.
  This step cannot be completed by the agent alone; hand the QR code to the
  operator and wait.
- If a wallet is **already connected**, the command prints the live session and
  exits. That is success, not an error.

## Step 4 — Verify

| Command | Success signal | Failure handling |
| --- | --- | --- |
| `ac2 service status` | Exit code 0; reports service and connection status. | Exit code 1 means the service is not running → run `openclaw ac2 pair` (it auto-starts the service). |
| `openclaw ac2 status` | Reports the connected wallet. | See the status branch table below. |

Status branches (documented behaviors):

| Observed status | Meaning | Action |
| --- | --- | --- |
| Connected wallet reported | Install complete. | Done. |
| `idle (waiting for a runtime before awaiting a wallet)` | The service will not await a wallet until an agent runtime is alive. | Run `openclaw ac2 pair` — it selects the `openclaw-gateway` runtime adapter for you. |
| Locked / wallet paired but nothing reaches the agent | The agent is bound to a different wallet (first-controller lock). | `openclaw ac2 forget`, then `openclaw ac2 pair`. |
| Service not running (commands report it; they never auto-start it) | `status`, `connections` and `forget` are read-only. | Run `openclaw ac2 pair` to start the service. |
| Nothing happens after a scan | Signaling unreachable: pairing goes through the Liquid Auth signaling server; both the phone and this machine must reach it. | Check `ac2 service logs -n 50` and network egress. |

## Upgrade

```sh
openclaw plugins update ac2 --dry-run   # preview first
openclaw plugins update ac2
openclaw gateway restart
```

A service that was already running keeps the runtime it started with. If turns
are not running after an upgrade:

```sh
ac2 service stop
openclaw ac2 pair
```

## Uninstall

```sh
openclaw ac2 forget            # drop the pairing + agent identity (optional)
openclaw plugins uninstall ac2
```

## Reporting back to the operator

- On success, report the wallet connection as shown by `openclaw ac2 status`.
- Never report success without a passing verify step (Step 4).
- If pairing is pending, report that the QR code is waiting for the operator to
  scan — do not treat a pending pair as a failure.
