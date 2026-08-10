# AC2 service architecture

Background on how the AC2 service works, for people integrating with it or
operating it. For day-to-day use see the [README](./README.md); for the local
socket API see [PROTOCOL.md](./PROTOCOL.md).

## The shape of the system

```
  mobile wallet  ──(Liquid Auth signaling + WebRTC data channel)──►  AC2 service
   (controller)                                                       │
                                                                      │ runtime adapter
                                                                      ▼
                                                              agent runtime
                                                       (OpenClaw gateway, your own, ...)
```

The service is the only process that talks to the wallet. Agents never open
their own wallet connection, which is what lets several agents (and future
protocols) share one paired wallet.

Responsibilities:

| Area | What the service does |
| --- | --- |
| Pairing | Runs the Liquid Auth handshake and issues the invitation a wallet scans. |
| Transport | Keeps a WebRTC data channel open, reconnects it, and tracks peer presence. |
| Identity | Generates its own `did:key`, and stores the per-agent identity keys the wallet issues. |
| Keys | Hosts the OS-keychain-backed keystore and signs through it. |
| Brokering | Routes wallet traffic to the right agent, and brokers request/response round-trips such as signing. |

## Identity model

There are two kinds of identity, and they come from different places.

- **The service identity** is self-generated on first start: a `did:key` derived
  from a key the service creates in its keystore. It identifies the service to
  the wallet.
- **Agent identities are issued by the wallet.** When an agent first appears, the
  service asks the connected wallet for a key (`ac2/KeyRequest`) and stores the
  result. Agents never mint their own identity, and never see raw key material:
  they ask the service to sign on their behalf.

**First-controller lock.** An agent stays bound to the first wallet that granted
it an identity. If a different wallet connects later, for example because the
mobile app was reinstalled and now presents a new account key, the service
refuses the takeover: it neither reuses the bound identity nor issues a fresh
one. The connection is marked `locked`, inbound wallet traffic is dropped, and
the wallet is shown a notice. Outbound `agent.send` still works so the agent can
explain itself. Clear the binding with `ac2 forget` before pairing a new wallet.

## Key storage

Keys live in the upstream keystore
([`@algorandfoundation/keystore-node`](https://github.com/algorandfoundation/wallet-provider-extensions)).
The service has no storage engine of its own.

- **Secret material** is kept in the OS keychain (Keychain on macOS, Secret
  Service on Linux, Credential Manager on Windows), under a service name derived
  from the state directory, so separate AC2 homes never collide.
- **On macOS the service uses a dedicated keychain** (`ac2-keystore.keychain-db`
  in the state directory, password in the `0600` file `ac2-keystore.keychain-key`
  next to it) that it creates and unlocks itself. The login keychain is locked
  for background processes (launchd, SSH, before login) and fails with
  `errSecInteractionNotAllowed` there; the dedicated keychain needs no user
  interaction, so pairing works headless. Entries older versions wrote to the
  login keychain are migrated on first read; `AC2_KEYRING=login` opts back into
  the login keychain.
- **Metadata** (key ids, public keys, algorithms) lives in one sealed blob,
  `ac2-keystore-metadata.bin`, beside the persisted connection records.
- **Identity keys are non-extractable.** The service signs through the keystore
  instead of reading private material back out.
- The service also **serves that same keystore** over the keystore RPC socket, so
  other tools share one store instead of opening a second one.

Releases before this one shipped an AC2-owned engine that kept an encrypted
`ac2-keystore.json` in the state directory. It is migrated on first start: every
key is re-imported under its existing id, so service and agent DIDs do not
change, and the old file is kept as `ac2-keystore.json.migrated`. A migration
that cannot complete leaves the file untouched and is retried next start.

## Connection lifecycle

### Resuming a pairing after a restart

If a previously paired connection is persisted, the service re-arms the pairing
cycle **on the same `requestId`** at startup, so it is already awaiting the
wallet's re-link. The returning wallet reconnects in place with no rescan and no
manual `ac2 pair`. This is what lets a restarted service (after `ac2 service
stop`/`start`, a crash, or a reboot under OS supervision) recover its wallet link
on its own. A fresh install with no persisted connection stays idle until you
pair. Turn it off with `DaemonRunOptions.resumeConnections = false`.

### Awaiting a wallet only when a runtime is alive

The service does not await a wallet, neither a fresh pairing nor the resume
above, until at least one agent runtime is alive. Otherwise a returning wallet
would re-link to a service with nothing behind it to answer. "Alive" means
either:

- the active runtime adapter reported ready, for example the `openclaw-gateway`
  adapter completed its WebSocket handshake, or
- with the default `socket` adapter, an agent registered over the control socket
  with `agent.hello`.

While holding off, `ac2 service status` shows `connection: idle (waiting for a
runtime before awaiting a wallet)` and `daemon.status.waitingForRuntime` is
`true`. It flips as soon as a runtime is alive. Disable with
`DaemonRunOptions.waitForRuntime = false` or `AC2_WAIT_FOR_RUNTIME=0`.

### Presence, heartbeat and teardown

Two signals can say the wallet is gone, and they are not equally fast:

- **Signaling presence** from the Liquid Auth server is fast and authoritative
  while the service's own signaling socket is up. A presence drop tears the peer
  link down (the signaling socket stays open) and the service immediately re-arms
  to await the returning wallet.
- **The data-channel heartbeat** is the slow fallback. It is only allowed to tear
  the link down when the signaling socket is *not* connected, so a stale
  heartbeat never kills a link the server still reports as present.

The service connects to signaling **polling-first** before upgrading to
WebSocket. That is deliberate: the Liquid Auth server creates the session during
the HTTP handshake, and a WebSocket-first client is never counted as a present
device, which used to make wallets tear pairings down with "peer went offline".

## Runtime adapters

A runtime adapter is the seam between the wallet connection and whatever runs the
agent. The contract is published as
[`@algorandfoundation/ac2-sdk/runtime`](../ac2-sdk/README.md#runtime-adapters):
the adapter receives inbound wallet frames plus a small host object for sending
outbound ones, and knows nothing about pairing, transports or the control socket.

Adapters are resolved by short built-in name first, then by importing the string
as an npm package specifier. A third party can publish an adapter and point the
service at it (`AC2_RUNTIME=my-adapter-package`) without any change to the
service. An adapter that fails to load is reported and skipped; it never takes
the service down.

Two adapters ship in the box.

### `socket` (default)

Hands inbound frames to whichever control-socket agent registered for the target
agent id. This is the long-standing behaviour, and nothing changes for a service
with no runtime configured.

### `openclaw-gateway`

Drives an OpenClaw agent over the OpenClaw Gateway WebSocket/RPC control plane
(protocol v4) instead of an in-process agent. See
[Gateway adapter](#the-openclaw-gateway-adapter) below.

### The selected adapter is remembered

When the service starts with an **explicitly selected** adapter, through
`DaemonRunOptions.runtime.adapter` or `AC2_RUNTIME`, that choice and its config
are persisted in the state directory once the adapter loads. A later bare
`ac2 service start`, and the OS supervision unit (which carries no environment of
its own), reuse the remembered adapter instead of reverting to `socket`. This is
what stops a service you put on the gateway adapter from going idle after a plain
restart.

Precedence: explicit `runtime.adapter`, then `AC2_RUNTIME`, then the persisted
selection, then the `socket` default. An explicit option or env var always wins
and updates what is remembered, so `AC2_RUNTIME=socket` is how you roll back.
Only successful explicit selections are remembered; a failed load and the
`socket` fallback are never written. `ac2 forget --all` deliberately preserves the
remembered adapter: it forgets connections and identities, not which runtime the
service runs.

## The `openclaw-gateway` adapter

Selecting this adapter makes the **Gateway the owner of conversation state**. The
adapter stores no transcript on the AC2 side; it only tracks the in-flight run
needed to answer the current wallet turn.

### Selecting and configuring it

In precedence order:

- `DaemonRunOptions.runtime = { adapter: 'openclaw-gateway', config: { url, token, agentId } }`
- `AC2_RUNTIME=openclaw-gateway` plus `AC2_RUNTIME_CONFIG='{"url":"...","token":"...","agentId":"..."}'`
- `AC2_RUNTIME=openclaw-gateway` plus `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_PORT` / `OPENCLAW_GATEWAY_TOKEN`
- auto-discovery from `openclaw.json` (lowest priority, see below)

`url` defaults to `ws://127.0.0.1:18789`. `token` and `agentId` are optional: an
unauthenticated local gateway needs neither, and an unset `agentId` lets the
Gateway pick its own default agent. A Gateway configured for token auth
**requires** a valid token; without one the handshake is rejected with
`NOT_PAIRED` / `DEVICE_IDENTITY_REQUIRED`.

Other config keys, each with a defensive default (an invalid value is logged and
ignored rather than thrown):

| Key | Default | Purpose |
| --- | --- | --- |
| `historyLimit` | `100` | Messages fetched via `chat.history` when replaying a thread. |
| `taskTimeoutMs` | `900000` | Timeout for awaiting a delegated sub-agent run. |
| `conversationsLimit` | `100` | Sessions fetched via `sessions.list` when advertising threads. |

### Device identity and operator scopes

The Gateway grants a connection its operator scopes from the **identity behind
the connection**, not from the scopes the client asks for. A connect carrying
only a shared token is *unbound*: the Gateway answers `hello-ok` anyway (an
operator with valid shared auth may skip device identity) but drops the
requested scopes first, so every later call fails with
`missing scope: operator.read` / `missing scope: operator.write` on a connection
that looked healthy.

So the service authenticates as a **device**, using the key it already has:

1. The Gateway pushes a `connect.challenge` event as soon as the socket opens.
2. The service answers with `connect` carrying a `device` block — an Ed25519
   signature over the challenge nonce, the requested scopes, the client
   identity and the token — which BINDS `operator.read` + `operator.write` to
   its key.
3. `hello-ok.auth.scopes` is then **verified**: a handshake that granted less
   than the adapter needs fails with a remediation hint instead of connecting
   into a stream of permission errors. `operator.admin` counts as covering
   everything.
4. Any `hello-ok.auth.deviceToken` is persisted and replayed as
   `auth.deviceToken` on later connects, so a paired service keeps working even
   where no shared token is configured.

The signing key is the daemon's **own service key** (`ac2-service` in the AC2
keystore) — the same self-generated Ed25519 key its `did:key` service identity
is derived from, and the one key in the keystore that is not wallet-issued.
Authenticating to the Gateway is an assertion of who this daemon is, so there
is no second key and no key file: the private material stays non-extractable
in the keystore and the adapter only ever asks it for a signature. The device
id the Gateway registers is SHA-256 over that key's raw public key, and any
issued device token is kept in the keystore's sealed **secret** store
(`ac2-gateway-device-token:operator`) rather than on disk.

Built-ins reach the key through `serviceKeystore`, a daemon-internal host
capability (`src/runtime/keystore-host.ts`) that a loaded third-party adapter
never sees — the same arrangement as `SocketRuntimeHost`. A keystore that
cannot sign (locked keychain, failed migration) is not fatal: the connect goes
out unsigned and the scope check above reports it.

On a loopback gateway the first connect is typically approved silently — if it
is not, approve the device on the OpenClaw side (`openclaw devices`).

### Auto-discovering the token and port

When neither token nor URL is supplied, the adapter reads **OpenClaw's own config
file** and lifts the gateway settings from it, so a service auto-started by the
OpenClaw plugin works against a token-guarded local Gateway without anyone
exporting `OPENCLAW_GATEWAY_TOKEN` first.

- **Path**, resolved the same way the plugin does: `OPENCLAW_STATE_DIR`, then
  `OPENCLAW_CONFIG_PATH`, then `OPENCLAW_HOME`, then `~/.openclaw/openclaw.json`.
- **Token** from `gateway.auth.token`, falling back to `gateway.remote.token`.
  An **absent** `gateway.auth.mode` still means token auth — that is the
  Gateway's own default — so the token is lifted then too; only an explicit
  non-token mode suppresses it (a stale token under another auth mode would
  only get the handshake rejected).
- **URL** built as `ws://127.0.0.1:<gateway.port>`.

Discovery is strictly lowest priority, best-effort, and never fatal: a missing or
malformed `openclaw.json` falls back to the defaults. The service logs which
source each value came from.

### What the wallet sees

- **Threads are advertised.** On connect the adapter calls `sessions.list` and
  sends the controller's threads to the wallet. Sub-agent sessions are excluded,
  and a failure here only logs.
- **Activity follows the thread the wallet is looking at.** The service's
  `conversation.changed` event drives the adapter's active-thread tracking, so a
  plain wallet message targets the open thread rather than always the default one.
  Opening a thread replays and subscribes it.
- **One wallet message per committed reply segment.** A turn that calls a tool
  mid-way renders as separate items (intro, then the tool or signing card, then
  the final reply) instead of one merged bubble.
- **Tool calls become durable cards.** Each tool call is re-emitted under a stable
  card id across start, update and result, so the wallet updates it in place.
  Output is merged tolerantly and capped; an error result still produces a card.
- **Sub-agent work becomes a task card** that moves from running to completed or
  failed. The child run is awaited detached, so the parent reply is never blocked
  on it.
- **History replay keeps the cards.** A history frame replaces the wallet's copy
  of a thread, so replay reconstructs tool and task cards from the transcript
  rather than sending text only.

Tool activity needs its own subscription: the Gateway keeps committed transcript
segments and session events in separate registries, so the adapter subscribes to
both. Without the event subscription no tool or task card can ever appear.

### Known limitations

- `agent.wait` carries no final assistant text; the per-segment commits are
  authoritative. A run that emits none falls back to the streamed text and then
  to `chat.history`, but only to a message recorded at or after the run started.
  A turn that legitimately produces no text (it only delegated and yielded) just
  clears the activity indicator instead of re-posting the previous answer.
- Tool events are gated server-side on a visible session, so a run started with
  visible-session effects suppressed produces no cards. The message split never
  depends on them, and a missed start phase is tolerated.
- A replayed task card is always reported completed; old child runs are never
  re-awaited.

The handshake, history read, run RPCs and streaming events were validated against
a live Gateway (server `2026.7.1-2`, protocol v4). Two corrections found during
that work: the Gateway does not send a top-level `hello-ok` frame, it answers the
`connect` request with a response whose payload is the `hello-ok`; and a
successful `hello-ok` says nothing about the scopes granted — those must be read
from `hello-ok.auth.scopes` and checked.

## Where state lives

| Path | Contents |
| --- | --- |
| `~/.ac2/ac2d.sock` | Control socket (override with `AC2_DAEMON_SOCKET`). |
| `~/.ac2/ac2d.log` | Append-only service log, read by `ac2 service attach` / `logs`. |
| `~/.ac2/ac2d.pid` | Pidfile for the detached process. |
| `~/.ac2/AC2.app` | macOS only: the launcher the launchd agent runs (see below). Generated by `ac2 service install`. |
| state directory | Persisted connections, agent identities, the remembered runtime, and the sealed keystore metadata. |
| OS keychain (via the keystore) | The `ac2-service` key that signs the `openclaw-gateway` handshake, and the device token it is issued (secret `ac2-gateway-device-token:operator`). |

`AC2_HOME` moves the runtime files (default `~/.ac2`). The state directory is
`AC2_STATE_DIR`, falling back to `OPENCLAW_STATE_DIR` and then `~/.openclaw`, so
an OpenClaw install keeps its AC2 state next to its own.

### The supervision unit carries the environment

launchd and systemd start the service from the user's bare login context: it
inherits **nothing** from the shell that ran `ac2 service install`. So the
installer captures every AC2/OpenClaw variable that is set at that moment into
the unit (`Environment=` lines, or the plist's `EnvironmentVariables`) and
reports which ones it wrote. Earlier releases carried `AC2_HOME` alone, which
silently moved the state directory back to the default — a supervised service
then ran with a different keystore and no connections. The unit is written mode
`0600`, since it can hold a gateway token.

### The macOS agent runs a launcher, not `node`

macOS Background Task Management names a background item after **the program the
launchd job launches**, not after the job's `Label`. With `ProgramArguments[0]`
pointing straight at the Node binary, the user was asked to allow *"node"* to run
in the background and saw an anonymous `node` entry in Login Items & Extensions —
easy to mistake for something else and switch off.

So `ac2 service install` generates `$AC2_HOME/AC2.app`: an `Info.plist`
(`CFBundleName` = `AC2`, `LSBackgroundOnly`) plus one shell executable,
`Contents/MacOS/ac2d`, which `exec`s the very same `node … service run` command
the plist used to hold. The job runs that launcher, so macOS reads the bundle and
displays **AC2**; if it ever ignores the bundle it reads the executable name,
`ac2d`, still never `node`. `exec` keeps launchd supervising (and signalling) the
daemon itself rather than an idle parent shell, and `service run` also sets its
process title to `ac2d` for `ps`/Activity Monitor.

The bundle is ad-hoc code signed (identifier `com.algorandfoundation.ac2`) to give
the OS a stable identity to attribute the item to; signing is best-effort, since
the name comes from the `Info.plist` either way. It is rebuilt on every install
(a stale signature would make `codesign` refuse) and removed by
`ac2 service uninstall`. macOS caches the registered item, so relabelling an
existing install needs an unload, uninstall, install, load cycle.

### Liveness comes from the socket, not the pidfile

Only a daemon started detached by `ac2 service start` writes `ac2d.pid`; one
under OS supervision runs `service run` in the foreground and writes no pidfile.
Liveness is therefore decided by the control socket first — whoever answers
`daemon.status` on it *is* the daemon, however it was started — with the pidfile
as the fallback for a daemon that was spawned but is not listening yet. That is
what makes `ac2 status` report a supervised service correctly, and what stops
`ac2 service start` (and an agent host's auto-start) from launching a second
daemon on top of a healthy one.

### Stopping exits the process explicitly

A daemon that owns its process (`service run` / `--foreground`; anything but the
in-process test embedding) calls `process.exit` itself once a stop — a signal or
a control-socket `daemon.stop` — has finished tearing down, instead of trusting
the event loop to drain: a paired daemon holds handles (native WebRTC peers,
socket.io reconnect timers) that can keep a fully-stopped process alive forever,
which is how a "stopped" daemon used to linger across a CLI reinstall until
killed by hand. A graceful stop that itself wedges is bounded by an unref'd
failsafe timer (exit code 1, so a supervisor can tell). `ac2 service stop`
mirrors this from the outside: it resolves the pid first (the socket reports it
even for a supervised daemon, which writes no pidfile), waits for the process to
actually exit after `daemon.stop`, and escalates to SIGTERM, then SIGKILL, when
it does not.
