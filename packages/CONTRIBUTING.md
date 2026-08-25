# Contributing to AC2

Thanks for your interest in contributing. This document describes the repository layout and the day-to-day workflow.

## Repository structure

This is a workspace monorepo.

```
ac2/
├── ac2.md                  AC2 protocol specification.
├── package.json            Workspace root (private).
├── build/                  Shared build tooling / release config.
└── packages/
    ├── ac2-sdk/                    TypeScript SDK (@algorandfoundation/ac2-sdk).
    │   ├── src/
    │   │   ├── client.ts           Ac2Client (symmetric request/response).
    │   │   ├── index.ts            Top-level barrel.
    │   │   ├── schema/             Types, type guards, decoder, validator.
    │   │   ├── protocol/           Message factories, builders, handlers.
    │   │   ├── transport/          Ac2Transport, RTC + in-memory adapters.
    │   │   ├── signaling/          Ac2ChannelProvider interface + did:key helpers.
    │   │   └── providers/          Liquid Auth + in-memory channel providers
    │   │                           (Liquid Auth's Node-only deps are optional,
    │   │                           dynamically imported).
    │   ├── tests/
    │   ├── README.md
    │   └── EXTENDING.md
    ├── ac2-cli/                    AC2 service + CLI (@algorandfoundation/ac2-cli).
    │   ├── src/
    │   │   ├── cli.ts              `ac2 …` binary (incl. `ac2 service …`).
    │   │   ├── daemon/             Long-lived daemon: broker, manager, run loop
    │   │   │                       (imports the channel providers from
    │   │   │                       @algorandfoundation/ac2-sdk/providers/*).
    │   │   ├── control/            NDJSON control socket (server, client,
    │   │   │                       agent session, Ac2Transport adapter).
    │   │   ├── identity/           Identity/keystore/state persistence.
    │   │   └── session/            Wallet identity bootstrap.
    │   ├── tests/
    │   ├── README.md               Install + day-to-day usage.
    │   ├── ARCHITECTURE.md         Service model, identity, keystore, runtime adapters.
    │   └── PROTOCOL.md             Control-socket API (methods, events, agent.request).
    └── ac2-open-claw-reference/    Reference OpenClaw plugin
                                    (@algorandfoundation/ac2-open-claw-reference).
        ├── src/
        │   ├── entry.ts            OpenClaw host entry (registerCliMetadata / registerFull).
        │   ├── index.ts            Programmatic barrel for embedded consumers.
        │   ├── runtime.ts          PLUGIN_ID, CHANNEL_ID, active host API/runtime refs.
        │   ├── channel/            ac2 channel plugin (delivery route, message adapter, plugin export).
        │   ├── session/            SessionManager, signing flows, tool-plugin contracts.
        │   ├── tools/              ac2_sign / ac2_capabilities tool builders + manifest.
        │   ├── cli/                `openclaw ac2 …` command implementation
        │   │                       (a client of the AC2 service).
        │   └── setup/              Setup entry + channel config / env var schema.
        │                           (The wallet connection, identity, and
        │                            keystore live in @algorandfoundation/ac2-cli;
        │                            the channel providers themselves live in
        │                            @algorandfoundation/ac2-sdk/providers/*.)
        ├── scripts/bundle.mjs      Flat tree-shakeable dist builder
        │                           (src/foo/bar.ts → dist/foo.bar.js, deps stay external).
        ├── tests/
        ├── openclaw.plugin.json    OpenClaw plugin manifest.
        ├── README.md               Install + day-to-day usage.
        └── ARCHITECTURE.md         Plugin/service/gateway split, identity, x402.
```

Additional packages (signaling providers, integrations) live under `packages/` and follow the same conventions.

## Prerequisites

- Node.js >= 18 (CI uses Node 24).
- pnpm (the release workflow runs on pnpm; honor the workspace's `packageManager` field if set).

## Common tasks

From the repo root:

```sh
pnpm install
pnpm -r build         # build all packages
pnpm -r test          # run all package test suites
pnpm -r type-check    # tsc --noEmit across the workspace
```

From a single package (e.g. `packages/ac2-sdk`):

```sh
pnpm build
pnpm test
pnpm docs             # typedoc
```

## Coding conventions

- TypeScript with strict mode.
- ESM-first; subpath exports are declared in each package's `package.json` `exports` map.
- Prefer pure functions and small modules; keep transports and signaling providers separable.
- Tests run under Vitest (`vitest run --globals`).

## Pull requests

1. Fork and create a feature branch.
2. Add or update tests for any behavior change.
3. Run `pnpm -r build && pnpm -r test` locally.
4. Open a PR against `master`. Describe the change, link any related issues, and call out spec impact if any.

## Releasing

Releases are automated by `.github/workflows/release.yml` on pushes to `master` / `release`. Maintainers should:

- Land changes on `master` via PR.
- Promote `release` when ready to cut a version.
- The workflow runs `pnpm install`, `pnpm run --if-present build`, and `pnpm run release`, then publishes with npm provenance (`publishConfig.provenance: true`).

## Spec changes

The AC2 protocol is defined in [`ac2.md`](./ac2.md). Any SDK change that affects wire format, message types, or transport semantics must include a matching update to the spec in the same PR.

## Extending the SDK

For extending message types, adding transports, or writing signaling providers, see [`packages/ac2-sdk/EXTENDING.md`](./packages/ac2-sdk/EXTENDING.md).

## OpenClaw reference plugin

[`packages/ac2-open-claw-reference`](./ac2-open-claw-reference) (`@algorandfoundation/ac2-open-claw-reference`) is the reference OpenClaw plugin for AC2. It implements both the tool and channel interfaces — `ac2_sign` / `ac2_capabilities` tools plus the `ac2` channel.

**The plugin does not own the wallet connection.** It is a *client of the AC2 service* (`@algorandfoundation/ac2-cli`), which runs as a standalone daemon and owns Liquid Auth + WebRTC pairing, controller binding, the agent's identity bootstrap, identity/keystore persistence and reconnect. The plugin talks to it over the daemon's NDJSON control socket (`@algorandfoundation/ac2-cli/control`) and mirrors the connection into its `SessionManager`:

- `openclaw ac2 pair` connects via `connectAgentSession`, **auto-starting the daemon** if needed, streams the daemon's QR, and activates/clears the session from `connection.connected` / `connection.disconnected` events. It never re-pairs locally.
- `ac2 service start|stop|status|attach|logs|install` manages the service lifecycle.
- `openclaw ac2 status` / `connections` / `forget` (and the `/ac2` slash command) are read-only daemon queries (`daemon.status`, `connections.list`, `connections.forget`) and never auto-start the daemon.

When changing anything under `packages/ac2-cli/src/**`, re-run `pnpm --filter @algorandfoundation/ac2-cli build` before running the plugin's tests: the plugin resolves `@algorandfoundation/ac2-cli/control` from that package's `dist/`.

Key entry points (declared in `openclaw.plugin.json` and `package.json#openclaw`):

- `dist/entry.js` — OpenClaw host extension. Exposes `registerCliMetadata` (`/ac2` slash command, `openclaw ac2 …` shell CLI) and `registerFull` (`ac2_sign`, `ac2_capabilities` tools).
- `dist/setup.index.js` — setup entry (`channels: ["ac2"]`, `channelEnvVars`, `status`, `setup`). Never boots the channel runtime.
- `dist/channel.plugin.js` — the `ac2` channel plugin loaded lazily by the host SDK via `import.meta.url` resolution.

### Native dependencies

The two native addons — `@roamhq/wrtc` (WebRTC transport, an `optionalDependency` of `@algorandfoundation/ac2-sdk`, dynamically imported by `LiquidAuthChannelProvider`) and `@napi-rs/keyring` (OS keystore, a dependency of `@algorandfoundation/ac2-cli`) — do not belong to the plugin: the service pulls in the transport via the SDK and owns the keystore directly. They ship prebuilt platform binaries and are listed in the workspace-root `pnpm-workspace.yaml#onlyBuiltDependencies`, so a plain `pnpm install` builds them automatically — no manual `pnpm rebuild` step is needed for tests or local development. The plugin itself has **no native dependencies**, and `pnpm install:plugin` no longer rebuilds any.

### Build layout

The plugin ships a **flat, tree-shakeable** distribution. `scripts/bundle.mjs` transpiles each `src/<dir>/<file>.ts` to `dist/<dir>.<file>.js` (e.g. `src/channel/stream.ts` → `dist/channel.stream.js`) and rewrites relative imports to the flat sibling names. Every non-relative import (host SDK, third-party packages, Node built-ins, native addons) stays external — nothing is vendored. A second `--flatten-dts` pass flattens `tsc`-emitted `.d.ts` files the same way.

Common scripts (from `packages/ac2-open-claw-reference`):

```sh
pnpm build               # bundle + tsc + flatten d.ts
pnpm test                # vitest, loads sources from src/
pnpm install:plugin      # build + pack + `openclaw plugins install` + enable
pnpm uninstall:plugin    # `openclaw plugins uninstall ac2`
```

### Releasing the plugin

The plugin is published as `@algorandfoundation/ac2-open-claw-reference` via the same `@algorandfoundation/package-releaser` pipeline as the SDK (OIDC + `publishConfig.provenance: true`, package-scoped tags `ac2-open-claw-reference@${version}`). `pnpm run release:dry-run` from the package directory exercises the pipeline without publishing.
