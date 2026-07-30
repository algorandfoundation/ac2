# `@algorandfoundation/ac2-cli`

Command-line interface and background service for the **AC2** protocol.

## What is the AC2 Service?

The AC2 service is a standalone connection daemon that owns the lifecycle of
the wallet connection. It acts as a central hub for AC2-enabled agents,
managing the complexities of pairing and transport.

| Component              | Responsibility                                                                 |
| ---------------------- | ------------------------------------------------------------------------------ |
| **Liquid Auth**        | Handles pairing and cryptographic handshake with the mobile wallet.            |
| **Wallet Channel**     | Maintains a persistent WebRTC data channel for message transport.              |
| **Identity Persistence**| Manages the daemon's own `did:key` identity generated via the keystore.        |
| **Message Brokering**  | Routes messages between the wallet and registered agents (e.g., OpenClaw).      |

The service generates its own identity via the keystore, while each agent's
identity keys are **issued by the mobile wallet controller** (e.g. Pera or
Defly) and brokered through the daemon.

## Key Storage

Keys are held by the upstream keystore
([`@algorandfoundation/keystore-node`](https://github.com/algorandfoundation/wallet-provider-extensions)) —
the service has no storage engine of its own:

- **Secret material** lives in the OS keychain (Keychain on macOS, Secret
  Service on Linux, Credential Manager on Windows), filed under a service name
  derived from the state directory, so separate AC2 homes never collide.
- **Metadata** (key ids, public keys, algorithms) lives in one AES-GCM sealed
  blob, `ac2-keystore-metadata.bin`, next to the persisted connection records.
- Identity keys are **non-extractable**: the daemon signs through the keystore
  rather than reading private material back out.
- The daemon also serves this very keystore over the keystore RPC socket, so
  other tools share the same keys instead of opening a second store.

Earlier releases shipped an AC2-owned engine that kept an encrypted
`ac2-keystore.json` in the state directory. It is migrated automatically on the
first start: every key is re-imported under its existing id (so service and
agent DIDs are unchanged) and the old file is kept as `ac2-keystore.json.migrated`.
A migration that cannot complete leaves the file untouched and is retried on the
next start.

## Service Lifecycle

The AC2 service is designed to run in the background, surviving terminal
closure. It provides a "screen-like" experience where you can attach to the
logs and detach without interrupting the service.

- `ac2 service start`: Starts the daemon in a detached background process.
- `ac2 service stop`: Gracefully stops the background daemon.
- `ac2 service status`: Reports whether the daemon is running, its PID, and if a stale pidfile was found.
- `ac2 service attach`: Streams the live log to the terminal. Pressing **Ctrl+C** detaches the terminal, but the service keeps running.
- `ac2 service logs`: Displays the last 50 lines of the daemon log.

### Resuming an existing connection on restart

When the daemon starts and a previously-paired connection is persisted, it
**automatically re-arms the pairing cycle on the same `requestId`** so it is
already awaiting the wallet's re-link — the returning wallet reconnects in
place with no rescan and no manual `ac2 pair`. This is what makes a restarted
service (e.g. after `ac2 service stop`/`start`, a crash, or an OS reboot under
supervision) recover its wallet link on its own. A brand-new install with no
persisted connection stays idle until you pair. This behaviour is on by default
and can be turned off with `DaemonRunOptions.resumeConnections = false`.

### Awaiting a wallet only when a runtime is alive

The daemon does **not** start awaiting a wallet — neither a fresh pairing
(`autoPair`) nor the resume described above — until **at least one agent
runtime is alive**, so a returning wallet is never re-linked to a service that
has no agent behind it (it would just sit there with nothing able to answer).
"Alive" means one of:

- the active runtime adapter reported ready (e.g. the `openclaw-gateway`
  adapter's WebSocket handshake to the Gateway completed), or
- for the default `socket` adapter, an agent registered over the control
  socket via `agent.hello`.

While the daemon is holding off, `ac2 service status` shows
`connection: idle (waiting for a runtime before awaiting a wallet)` and
`daemon.status().waitingForRuntime` is `true`; it flips to `false` and arms
pairing/resume the moment a runtime becomes alive. This is on by default and
can be turned off with `DaemonRunOptions.waitForRuntime = false` or
`AC2_WAIT_FOR_RUNTIME=0` (restoring the legacy "arm immediately on startup"
behaviour).

### OS Supervision

For users who want the OS to ensure the daemon is always running:

- `ac2 service install`: Automatically detects the platform and installs a `systemd` user service (Linux) or `launchd` agent (macOS).
- `ac2 service uninstall`: Removes the OS supervision unit and stops further automatic starts.

## Client Commands

The `ac2` CLI provides several commands to interact with the running daemon:

- `ac2 pair`: Starts a pairing cycle and renders the QR code for the mobile wallet to scan.
- `ac2 status`: Displays the live connection snapshot, protocol version, and a list of registered agents.
- `ac2 connections`: Lists all persisted wallet connections known to the daemon.
- `ac2 forget`: Instructs the daemon to forget a specific connection and its associated agent identities.

## Environment Variables

| Variable                   | Description                                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| `AC2_HOME`                 | Root directory for daemon runtime state (default: `~/.ac2`).                |
| `AC2_DAEMON_SOCKET`        | Path to the control socket (Unix socket or Windows named pipe).             |
| `AC2_STATE_DIR`            | Directory where persisted connection records are stored.                    |
| `AC2_LIQUID_AUTH_SERVER`   | URL of the Liquid Auth signaling server.                                    |
| `AC2_DEFAULT_AGENT`        | The agent identifier to route traffic to by default (default: `openclaw`).   |
| `AC2_HEARTBEAT_TIMEOUT_MS` | Maximum duration to wait for a wallet heartbeat before reconnecting.        |
| `AC2_WAIT_FOR_RUNTIME`     | Gate awaiting a wallet on a live agent runtime (default on); `0`/`false`/`no`/`off` disables it. |
| `AC2_RUNTIME`               | Runtime adapter to load (built-in short name or npm specifier); default `socket`. |
| `AC2_RUNTIME_CONFIG`       | JSON object passed to the runtime adapter's `createRuntimeAdapter(host, config)`. |
| `OPENCLAW_GATEWAY_URL`     | OpenClaw Gateway WebSocket URL for the `openclaw-gateway` runtime adapter.  |
| `OPENCLAW_GATEWAY_PORT`    | Port used to build the default `ws://127.0.0.1:<port>` gateway URL. Falls back to `gateway.port` discovered from `openclaw.json`. |
| `OPENCLAW_GATEWAY_TOKEN`   | Bearer token sent as `auth.token` on the gateway connect handshake. Falls back to `gateway.auth.token` discovered from `openclaw.json` when `gateway.auth.mode` is `token`. |

## Runtime Adapters

The daemon routes inbound wallet traffic through a **runtime adapter** (see
`@algorandfoundation/ac2-sdk/runtime` for the contract). The default,
always-on adapter is `socket`: it hands inbound frames to whichever
control-socket agent is registered for the target agent id — this is the
long-standing behaviour and nothing changes for a daemon with no `runtime`
configured.

### The selected adapter is remembered across restarts

Whenever the daemon starts with an **explicitly-selected** adapter — via
`DaemonRunOptions.runtime.adapter` or the `AC2_RUNTIME` env var — that choice
(and its config, minus any internal seams) is persisted in the state directory
once the adapter loads successfully. A later **bare** `ac2 service start` /
restart — and the OS supervision unit installed by `ac2 service install`, which
carries no environment of its own — then reuses the remembered adapter instead
of silently reverting to `socket`. This is what keeps a service you put on
`openclaw-gateway` from going idle (`connection: idle (waiting for a runtime
before awaiting a wallet)`) after a plain restart.

Resolution precedence is therefore: explicit `runtime.adapter` → `AC2_RUNTIME`
→ **persisted selection** → the built-in `socket` default. An explicit option
or env var always wins and updates the remembered choice; setting
`AC2_RUNTIME=socket` explicitly is how you roll back a service to the socket
adapter. Only successful, explicit selections are remembered — an adapter that
fails to load is never persisted, and the `socket` fallback default is never
written. A full `ac2 forget --all` deliberately preserves this backend choice
(it forgets connections and identities, not which runtime the service runs).

### `openclaw-gateway`

An opt-in, first-party adapter that drives an OpenClaw agent over the
**OpenClaw Gateway** WebSocket/RPC control plane (protocol v4) instead of an
in-process control-socket agent. Selecting it makes the **Gateway the owner
of conversation/session state**: this adapter does not persist any
transcript on the AC2 side, it only tracks the single in-flight `agent` RPC
run needed to answer the current wallet turn. On (re)connect it also
**restores the default thread's past conversation** to the wallet: it reads it
back from the Gateway (`chat.history`, scope `operator.read`) and replays it as
a single `history` control frame, so a returning or fresh wallet sees its
history even though nothing is stored AC2-side.

Select it with any of, in precedence order:

- `DaemonRunOptions.runtime = { adapter: 'openclaw-gateway', config: { url, token, agentId } }`
- `AC2_RUNTIME=openclaw-gateway` plus `AC2_RUNTIME_CONFIG='{"url":"...","token":"...","agentId":"..."}'`
- `AC2_RUNTIME=openclaw-gateway` plus `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_PORT` / `OPENCLAW_GATEWAY_TOKEN`
- **Auto-discovery from `openclaw.json`** (lowest priority — see below)

`url` defaults to `ws://127.0.0.1:18789`; `token` and `agentId` are optional
(an unauthenticated local gateway needs neither, and an unset `agentId` lets
the Gateway use its own default agent). Note that a Gateway configured with
`gateway.auth.mode: 'token'` **requires** a valid `token` — connecting without
one is rejected at the handshake with `NOT_PAIRED` / `DEVICE_IDENTITY_REQUIRED`.

Other `config` keys, all with defensive defaults (an invalid value is logged
and ignored rather than thrown):

| Key | Default | Purpose |
| --- | --- | --- |
| `historyLimit` | `100` | Max messages fetched via `chat.history` when replaying a thread on connect/switch. |
| `taskTimeoutMs` | `900000` | Timeout passed to `agent.wait` while awaiting a `sessions_spawn` child run in the background (see "Sub-agent task cards" below). |
| `conversationsLimit` | `100` | Max sessions fetched via `sessions.list` when advertising a controller's threads on connect. |

#### Auto-discovering the token and port from `openclaw.json`

When neither the token nor the URL is provided by config or the environment,
the adapter falls back to reading **OpenClaw's own config file** and lifts the
gateway connection settings from it — so a daemon auto-started by the OpenClaw
plugin "just works" against a token-guarded local Gateway without anyone having
to export `OPENCLAW_GATEWAY_TOKEN` first (the daemon inherits the plugin's
environment and resolves the same file the plugin does):

- **Config file path** (same resolution the plugin uses):
  `OPENCLAW_STATE_DIR` → `OPENCLAW_CONFIG_PATH` → `OPENCLAW_HOME` →
  `~/.openclaw/openclaw.json`.
- **Token**: taken from `gateway.auth.token`, but **only** when
  `gateway.auth.mode` is `'token'` (a non-token auth mode never yields a token
  — a stale token would only get the handshake rejected).
- **URL**: built as `ws://127.0.0.1:<gateway.port>` from the discovered port.

Discovery is strictly the **lowest-priority** source: explicit config and the
`OPENCLAW_GATEWAY_*` env vars always win, and the file is only read when
something is still unresolved. It is best-effort and never fatal — a missing or
malformed `openclaw.json` simply falls back to the built-in defaults. The
daemon logs which source a value came from, so an operator can confirm whether
a token/port was discovered or supplied explicitly.

> **Validated against a live Gateway** (server `2026.7.1-2`, protocol v4): the
> connect handshake, `chat.history`, `sessions.messages.subscribe`, `agent` /
> `agent.wait`, the `chat` streaming events, and the history-replay frame were
> all exercised end-to-end. One correction found and fixed during validation:
> the Gateway does **not** send a top-level `hello-ok` frame — it answers the
> `connect` request with a `res` whose `payload` is the `hello-ok` (preceded by
> a `connect.challenge` event, which token auth does not need to answer).

**Multi-thread support (implemented):**

- **Conversations are advertised.** On a non-locked `onConnected` (and best-
  effort — a `sessions.list` failure just logs and skips it), the adapter
  calls `sessions.list` (scope `operator.read`, `{limit: conversationsLimit,
  includeDerivedTitles: true}` — this Gateway rejects an unsupported `sortBy`,
  so newest-first ordering is done client-side) and sends a `conversations`
  frame with this controller's threads (matched case-insensitively on the DID,
  since the wallet's `did:key:` is mixed-case but the Gateway lower-cases
  session keys; sub-agent sessions are excluded).
- **Activity follows the thread the wallet is looking at.** The daemon's
  `conversation.changed` control event (see "Agent Integration" below) drives
  an `onConversation` hook that tracks the active thread: a bare, non-JSON
  wallet frame (no explicit `thid`) now targets that thread instead of always
  the default one, and opening a thread also replays its history and
  subscribes it, so switching threads in the wallet restores what was there.
- **History replay includes tool/task cards, not just text.** Because a
  `history` frame REPLACES the wallet's local copy of a thread, a text-only
  replay used to erase the tool/task cards a user had already seen live. The
  exported `mapHistoryMessages` (see `src/runtime/gateway/adapter.ts`)
  reconstructs them from the same `chat.history` transcript.

**Durable tool and sub-agent task cards (implemented):**

- **Tool activity requires its own subscription.** The Gateway keeps two
  registries: `sessions.messages.subscribe` gets committed transcript segments,
  while `session.tool` — the only stream carrying tool activity — goes to
  session *event* subscribers. The adapter therefore also issues
  `sessions.subscribe` (no params, `operator.read`) once per gateway link and
  again after each reconnect. Without it no tool/sub-agent card can ever
  appear, which is exactly why they had gone missing (confirmed live — see
  `docs/gateway-live-validation.md`, update `2026-07-31c`).
- Each `session.tool` call is now a durable card (`buildToolFrame`), not just
  an ephemeral `preview(tool)` indicator: the same card id is re-emitted across
  `start`/`update`/`result` so the wallet upserts it in place, with output
  merged tolerantly (snapshot-or-delta) and capped. An error result still
  produces a card (the output carries the error text).
- A `sessions_spawn` call becomes a task card (`buildTaskFrame`, `running` →
  `completed`/`failed`) instead of vanishing: the delegated child run is
  awaited **detached** from the parent turn (`sessions_yield` ends the parent
  turn while it runs), so the parent's reply is never blocked on it.

**Remaining limitations:**

- `agent.wait` carries no final assistant text; the per-segment
  `session.message` commits are authoritative. When a run emits no
  `session.message` at all, the reply falls back to the streamed `chat` text
  and then to `chat.history` — but only to a message recorded at/after the run
  started. A turn that legitimately produces no assistant text (it only
  delegated to a sub-agent and yielded) therefore just clears the live
  indicator instead of re-posting the previous turn's answer as a new bubble.
- `session.tool` is still gated server-side on a visible session, so a run
  started with visible-session effects suppressed yields no cards; the
  message-split behaviour never depends on it, and a missed `start` phase is
  tolerated (a card is synthesized from `update`/`result` alone, just without
  a `command`).
- Tool cards are keyed `tool-<toolCallId>` both live and when reconstructed
  from `chat.history`, so a replay coalesces with a card already on screen.
  Task cards likewise share the `task-<childSessionKey>` id — but a replayed
  task card is always reported `completed` (old children are never re-awaited).

## Agent Integration

Integrating a new agent with AC2 is simple. Agents connect to the daemon over
the control socket using newline-delimited JSON (NDJSON).

See `src/control/protocol.ts` for the complete protocol definition.

**Example: Agent Registration**
```json
{"id": 1, "method": "agent.hello", "params": {"agent": "openclaw", "host": "my-host"}}
{"id": 1, "result": {"protocolVersion": 1, "serviceDid": "did:key:...", "identity": null}}
```

**Example: Inbound Message Notification**
```json
{"event": "message.inbound", "data": {"agent": "openclaw", "payload": "...", "channel": "control"}}
```

**Example: Conversation Changed Notification**

Fired from the broker's `ac2/ConversationOpen` / `ac2/ConversationClose`
handlers and forwarded to the active runtime adapter's `onConversation` hook
(see the `openclaw-gateway` adapter's thread-tracking behaviour above) — this
is how the daemon tells a runtime which thread the wallet is currently
looking at.

```json
{"event": "conversation.changed", "data": {"kind": "open", "thid": "t1", "title": "Support request", "controllerDid": "did:key:...", "requestId": "..."}}
{"event": "conversation.changed", "data": {"kind": "close", "thid": "t1", "controllerDid": "did:key:...", "requestId": "..."}}
```

### Wallet round-trips through the daemon (`agent.request`)

Because the daemon owns the wallet transport, it also owns every
request/response round-trip with the wallet. When an agent needs the wallet to
do something (sign a payload, and in future issue a key or an attestation), it
calls the single, **verb-agnostic** `agent.request` control method rather than
trying to run its own client: the wallet's reply (e.g. an `ac2/SigningResponse`)
is an AC2 message routed to the daemon's own `Ac2Client` (the `onMessage`
path), **not** to the `onRawMessage` path that produces `message.inbound` — so
an agent that sent a `SigningRequest` itself would never observe the reply.

The caller supplies the request `type`, its `body`, and the response `type`s
that settle the round-trip; the daemon fills the request's `from`/`to` from the
connected session's authoritative agent/controller DIDs (a caller cannot
address the request to anyone but the connected controller), sends it on the
wallet transport, and relays the wallet's raw response back verbatim for the
caller to interpret. The daemon never needs per-verb knowledge.

```json
{"id": 2, "method": "agent.request", "params": {"type": "ac2/SigningRequest", "body": {"description": "Sign this payload", "encoding": "base64", "payload": "..."}, "responseTypes": ["ac2/SigningResponse", "ac2/SigningRejected"]}}
{"id": 2, "result": {"status": "response", "message": {"type": "ac2/SigningResponse", "from": "did:key:...", "to": ["did:key:..."], "thid": "...", "body": {"signature": "...", "public_key": "...", "key_type": "account"}}}}
```

The result is either `{"status":"response","message":{…}}` — the wallet's raw
reply, which may itself be an approval (`ac2/SigningResponse`) or an
application-level rejection (`ac2/SigningRejected`), the caller decides — or
`{"status":"unavailable","reason":"locked"|"no_identity"}` for a daemon-side
gate that never reached the wallet. A call with no connected wallet is refused
with the `not_connected` error code so the agent can tell "not paired" apart
from a user rejection.
