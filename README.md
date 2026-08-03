# AC2 — Agentic Communication and Control

Monorepo for the **AC2 (Agentic Communication and Control) protocol**: a
peer-to-peer authenticated messaging system for secure communication between
users and AI agents. AC2 enables human-in-the-loop digital signing operations —
agents request signatures, users validate and approve through their own wallet
or application, and signatures are delegated back to the agent for continued
operations. Users keep custody of their keys at all times.

The protocol itself is specified in [ac2.md](ac2.md).

## Packages

| Package | npm | Summary |
| --- | --- | --- |
| [ac2-sdk](packages/ac2-sdk/) | `@algorandfoundation/ac2-sdk` | TypeScript SDK for the AC2 protocol. Transport-agnostic: the same `Ac2Client` runs over WebRTC DataChannels, an in-memory loopback pair, or any custom transport. |
| [ac2-cli](packages/ac2-cli/) | `@algorandfoundation/ac2-cli` | The **AC2 service**: a background process that holds one connection to a mobile wallet, plus the `ac2` command line that manages it. Owns the Liquid Auth pairing lifecycle, identity persistence, and keystore hosting so any agent can share one wallet connection. |
| [ac2-open-claw-reference](packages/ac2-open-claw-reference/) | `@algorandfoundation/ac2-open-claw-reference` | The reference [OpenClaw](https://docs.openclaw.ai/) plugin for AC2. Implements signing, chat, and x402 Algorand paid fetch over the AC2 service. |
| [ac2-open-claw-server](packages/ac2-open-claw-server/) | — (deployment) | Publicly accessible OpenClaw instance with the AC2 reference plugin: a Dockerized, token-protected web page for pairing a wallet by QR code. |

Shared release tooling lives in [build/](build/)
(`@algorandfoundation/package-releaser`).

## For agents and LLMs

Go directly to the document that matches your task:

| Task | Read |
| --- | --- |
| Understand the AC2 protocol (messages, signing flows, transport) | [ac2.md](ac2.md) |
| Install the OpenClaw plugin (human guide) | [packages/ac2-open-claw-reference/INSTALL.md](packages/ac2-open-claw-reference/INSTALL.md) |
| Install the OpenClaw plugin (agent/automation guide) | [packages/ac2-open-claw-reference/INSTALL-AGENT.md](packages/ac2-open-claw-reference/INSTALL-AGENT.md) |
| Use the plugin's tools, channel, and commands | [packages/ac2-open-claw-reference/README.md](packages/ac2-open-claw-reference/README.md) |
| How the plugin, service, and gateway divide the work | [packages/ac2-open-claw-reference/ARCHITECTURE.md](packages/ac2-open-claw-reference/ARCHITECTURE.md) |
| Run and manage the AC2 service (`ac2` CLI) | [packages/ac2-cli/README.md](packages/ac2-cli/README.md) |
| Service internals: identity, keystore, runtime adapters | [packages/ac2-cli/ARCHITECTURE.md](packages/ac2-cli/ARCHITECTURE.md) |
| Build a client of the service's control socket | [packages/ac2-cli/PROTOCOL.md](packages/ac2-cli/PROTOCOL.md) |
| Build with the SDK (`Ac2Client`, transports, providers) | [packages/ac2-sdk/README.md](packages/ac2-sdk/README.md) |
| Extend the SDK (custom transports, signaling providers) | [packages/ac2-sdk/EXTENDING.md](packages/ac2-sdk/EXTENDING.md) |
| Deploy a public pairing server | [packages/ac2-open-claw-server/README.md](packages/ac2-open-claw-server/README.md) |
| Repository layout and development workflow | [packages/CONTRIBUTING.md](packages/CONTRIBUTING.md) |

## Contributing

See [packages/CONTRIBUTING.md](packages/CONTRIBUTING.md) for the repository
structure, prerequisites, and day-to-day workflow.
