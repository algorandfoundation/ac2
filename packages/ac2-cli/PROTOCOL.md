# AC2 service control protocol

This document describes the local control socket the AC2 service listens on. It
is the interface you use when you want to drive the service from your own code
instead of from the `ac2` command line.

You do not need this document to *use* the service. Read it if you are:

- building an agent or a tool that needs the connected wallet to sign something,
- building a runtime adapter or another integration on top of the service,
- writing a client in a language other than TypeScript.

TypeScript users normally do not hand-write frames: the typed client and the
agent helpers in `@algorandfoundation/ac2-cli/control` cover everything below.

## Transport

- A Unix domain socket (`~/.ac2/ac2d.sock` by default) or, on Windows, a named
  pipe. Override the path with `AC2_DAEMON_SOCKET`.
- Framing is newline-delimited JSON (NDJSON): one JSON object per line, in both
  directions.
- Access control is filesystem permissions. Anything that can open the socket is
  treated as a local, trusted client.

There are three frame shapes.

```jsonc
// request  (client -> service)
{ "id": 1, "method": "daemon.status", "params": {} }

// response (service -> client), one per request id
{ "id": 1, "result": { /* ... */ } }
{ "id": 1, "error": { "code": "not_connected", "message": "no wallet connected" } }

// event    (service -> client), unsolicited, after `subscribe`
{ "event": "connection.connected", "data": { /* ... */ } }
```

`id` is chosen by the client and echoed back. Requests may be pipelined;
responses are correlated by `id`, not by order.

Error codes:

| Code | Meaning |
| --- | --- |
| `bad_request` | Malformed frame, unknown method, or invalid params. |
| `not_connected` | The call needs a live wallet channel and there is none. |
| `pairing_active` | A conflicting pairing cycle is already running. |
| `agent_taken` | Another socket already registered this agent id. |
| `not_found` | Unknown `requestId` or connection. |
| `internal` | Unexpected service-side failure. |

## Methods

### `daemon.status`

Returns everything an operator or client needs to know, including the live
pairing invitation. Reading it never changes the lifecycle.

```jsonc
{ "id": 1, "method": "daemon.status", "params": {} }
{
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "version": "1.0.0-canary.1",
    "pid": 4242,
    "startedAt": "2026-07-31T12:00:00.000Z",
    "serviceDid": "did:key:z6Mk...",
    "keystoreSocket": "/home/me/.algorand-keystore/keystore.sock",
    "connection": {
      "state": "connected",
      "requestId": "019fb80c-...",
      "controllerDid": "did:key:z6Mk...",
      "walletAddress": "FABIKJWA...",
      "origin": "https://debug.liquidauth.com",
      "locked": false
    },
    "pairing": { "requestId": "019fb80c-...", "qrPayload": "liquid://...", "origin": "https://debug.liquidauth.com" },
    "agents": [{ "agent": "openclaw", "host": "my-host", "connectedAt": "..." }],
    "defaultAgent": "openclaw",
    "runtimeAdapter": "openclaw-gateway",
    "waitingForRuntime": false
  }
}
```

`connection.state` is one of `idle`, `pairing`, `connected` or `reconnecting`,
and `connection.locked` is a separate flag. `pairing` is `null` when no cycle is
armed.

`pairing` exists so a client can render a scannable code at any time, including
while a wallet is connected (the service keeps the cycle armed so a wallet can
re-link without a rescan). Use it instead of `pair.start` whenever you must not
disturb the lifecycle.

### `daemon.stop`

Asks the service to shut down. Returns `{ "stopping": true }`.

### `pair.start`

Starts (or reuses) a pairing cycle and returns the invitation:
`{ requestId, qrPayload, origin }`. Optional `params.timeoutMs`. Render
`qrPayload` however you like; the service does not draw QR codes for you.

### `pair.cancel`

Cancels the armed cycle. Returns `{ "cancelled": true|false }`.

### `connections.list`

Returns `{ connections: [...] }`, the wallet connections persisted in the state
directory.

### `connections.forget`

`params: { requestId?: string, all?: boolean }`. Drops a persisted connection
and the agent identities that belong to it. Returns
`{ forgotten: ["<requestId>", ...] }`.

Forgetting everything deliberately keeps the remembered runtime adapter: it
forgets connections and identities, not which runtime the service runs.

### `agent.hello`

Registers this socket as the endpoint for an agent id. Required before the
service will route inbound wallet traffic to you under the default `socket`
runtime adapter.

```jsonc
{ "id": 2, "method": "agent.hello", "params": { "agent": "openclaw", "host": "my-host" } }
{
  "id": 2,
  "result": {
    "protocolVersion": 1,
    "serviceDid": "did:key:z6Mk...",
    "identity": { "agentDid": "did:key:z6Mk...", "keyId": "..." },
    "connection": { "state": "connected", "locked": false }
  }
}
```

A second socket claiming the same agent id is rejected with `agent_taken`.

### `agent.send`

Sends a payload to the connected wallet on behalf of an agent:
`params: { agent, channel?: 'control' | 'stream', payload }`. Returns
`{ delivered: boolean }`.

A locked connection still allows `agent.send`, so a locked agent can explain
itself to the wallet, while inbound wallet traffic stays blocked.

### `agent.request`

One verb-agnostic request/response round-trip with the wallet. This is how an
agent gets a signature, and how future wallet verbs (key issuance,
attestations) will work too, with no new method per verb.

```jsonc
{
  "id": 3,
  "method": "agent.request",
  "params": {
    "type": "ac2/SigningRequest",
    "body": { "description": "Sign this payload", "encoding": "base64", "payload": "..." },
    "responseTypes": ["ac2/SigningResponse", "ac2/SigningRejected"],
    "timeoutMs": 120000
  }
}
{
  "id": 3,
  "result": {
    "status": "response",
    "message": {
      "type": "ac2/SigningResponse",
      "from": "did:key:z6Mk...",
      "to": ["did:key:z6Mk..."],
      "thid": "...",
      "body": { "signature": "...", "public_key": "...", "key_type": "account" }
    }
  }
}
```

You supply the request `type`, its `body`, and the response `type`s that settle
the round-trip. The service fills `from` and `to` from the connected session's
authoritative agent and controller DIDs, so a caller cannot address a request to
anyone but the connected controller. The wallet's reply is relayed back
verbatim, for you to interpret.

Results:

- `{ "status": "response", "message": { ... } }`: the wallet's raw reply. It may
  be an approval (`ac2/SigningResponse`) or an application-level rejection
  (`ac2/SigningRejected`); deciding which is the caller's job.
- `{ "status": "unavailable", "reason": "locked" | "no_identity" }`: a
  service-side gate stopped the request before it reached the wallet.
- error `not_connected`: no wallet is linked, so the agent can tell "not paired"
  apart from "user declined".

Why this exists: the wallet's reply is an AC2 protocol message and lands on the
service's own client, not on the raw path that produces `message.inbound`. An
agent that sent a signing request itself would never see the answer, so the
service brokers the round-trip.

### `subscribe`

`params: { events?: [...] }` (all events when omitted). Returns the list of
event names now streaming to this socket.

## Events

| Event | Fires when |
| --- | --- |
| `connection.pairing` | A pairing cycle armed. Carries `{ requestId, qrPayload, origin }`. |
| `connection.connected` | A wallet linked. Carries the snapshot fields plus `locked`, `identityGranted` and `agentDid`. |
| `connection.disconnected` | The wallet link dropped. Carries `{ requestId, reason }`. |
| `connection.presence` | The signaling server reported the peer present or absent. |
| `message.inbound` | The wallet sent traffic for an agent. Carries `{ agent, channel, payload }`. |
| `conversation.changed` | The wallet opened or closed a conversation thread. |
| `agent.registered` / `agent.unregistered` | An agent endpoint appeared or went away. |

```jsonc
{ "event": "message.inbound", "data": { "agent": "openclaw", "channel": "control", "payload": "hello" } }

{ "event": "conversation.changed", "data": { "kind": "open", "thid": "t1", "title": "Support request", "controllerDid": "did:key:...", "requestId": "..." } }
{ "event": "conversation.changed", "data": { "kind": "close", "thid": "t1", "controllerDid": "did:key:...", "requestId": "..." } }
```

`conversation.changed` is how the service tells a runtime which thread the
wallet is currently looking at, so activity, replies and history land on the
right thread.

Note that `message.inbound` is only broadcast to control-socket agents. When a
runtime adapter such as `openclaw-gateway` owns the runs, inbound frames go to
that adapter exclusively.

## Minimal client

```ts
import { connectControl, ensureDaemonRunning } from '@algorandfoundation/ac2-cli/control';

await ensureDaemonRunning();
const client = await connectControl();

const status = await client.request('daemon.status', {});
console.log(status.connection.state, status.pairing?.qrPayload);

client.close();
```

For agents there is a higher-level helper, `connectAgentSession`, which does the
`agent.hello` handshake, buffers events, and exposes `send`, `startPairing`,
`status` and `close`. See the exports of
`@algorandfoundation/ac2-cli/control`.

## Compatibility

`daemon.status.protocolVersion` is the control protocol version. Additive
changes (new methods, new events, new optional fields) do not bump it; a client
should ignore fields it does not know. Check it after `agent.hello` if you
depend on a specific shape.
