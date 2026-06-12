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
    │   │   └── signaling/          Ac2ChannelProvider interface.
    │   ├── tests/
    │   ├── README.md
    │   └── EXTENDING.md
    └── ac2-open-claw-reference/    Reference OpenClaw plugin
                                    (@algorandfoundation/ac2-open-claw-reference).
        ├── src/
        │   ├── entry.ts            OpenClaw host entry (registerCliMetadata / registerFull).
        │   ├── index.ts            Programmatic barrel for embedded consumers.
        │   ├── runtime.ts          PLUGIN_ID, CHANNEL_ID, active host API/runtime refs.
        │   ├── channel/            ac2 channel plugin (routing, message adapter, plugin export).
        │   ├── session/            SessionManager, bootstrap, tool-plugin contracts.
        │   ├── tools/              ac2_sign / ac2_capabilities tool builders + manifest.
        │   ├── cli/                `openclaw ac2 …` command implementation.
        │   ├── setup/              Setup entry + channel config / env var schema.
        │   ├── identity/           Persisted DID / connection state.
        │   ├── keystore/           Keystore wiring (@napi-rs/keyring backed).
        │   └── providers/          LiquidAuth + in-memory Ac2ChannelProvider impls.
        ├── scripts/bundle.mjs      Flat tree-shakeable dist builder
        │                           (src/foo/bar.ts → dist/foo.bar.js, deps stay external).
        ├── tests/
        ├── openclaw.plugin.json    OpenClaw plugin manifest.
        └── README.md
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
4. Open a PR against `main`. Describe the change, link any related issues, and call out spec impact if any.

## Releasing

Releases are automated by `.github/workflows/release.yml` on pushes to `main` / `release`. Maintainers should:

- Land changes on `main` via PR.
- Promote `release` when ready to cut a version.
- The workflow runs `pnpm install`, `pnpm run --if-present build`, and `pnpm run release`, then publishes with npm provenance (`publishConfig.provenance: true`).

## Spec changes

The AC2 protocol is defined in [`ac2.md`](./ac2.md). Any SDK change that affects wire format, message types, or transport semantics must include a matching update to the spec in the same PR.

## Extending the SDK

For extending message types, adding transports, or writing signaling providers, see [`packages/ac2-sdk/EXTENDING.md`](./packages/ac2-sdk/EXTENDING.md).

## OpenClaw reference plugin

[`packages/ac2-open-claw-reference`](./ac2-open-claw-reference) (`@algorandfoundation/ac2-open-claw-reference`) is the reference OpenClaw plugin for AC2. It implements both the tool and channel interfaces — `ac2_sign` / `ac2_capabilities` tools plus the `ac2` channel — over Liquid Auth + WebRTC via `@algorandfoundation/ac2-sdk`.

Key entry points (declared in `openclaw.plugin.json` and `package.json#openclaw`):

- `dist/entry.js` — OpenClaw host extension. Exposes `registerCliMetadata` (`/ac2` slash command, `openclaw ac2 …` shell CLI) and `registerFull` (`ac2_sign`, `ac2_capabilities` tools).
- `dist/setup.index.js` — setup entry (`channels: ["ac2"]`, `channelEnvVars`, `status`, `setup`). Never boots the channel runtime.
- `dist/channel.plugin.js` — the `ac2` channel plugin loaded lazily by the host SDK via `import.meta.url` resolution.

### Native dependencies

The plugin pulls in three native addons: `node-datachannel` (WebRTC transport), `@napi-rs/keyring` (OS keystore), and `@roamhq/wrtc` (test transport). They are listed in the workspace-root `pnpm-workspace.yaml#onlyBuiltDependencies` so a plain `pnpm install` builds them automatically — no manual `pnpm rebuild` step is needed for tests or local development. If you ever need to force a rebuild (e.g. after switching Node versions), run `pnpm run dev:natives` inside the package.

### Build layout

The plugin ships a **flat, tree-shakeable** distribution. `scripts/bundle.mjs` transpiles each `src/<dir>/<file>.ts` to `dist/<dir>.<file>.js` (e.g. `src/channel/routing.ts` → `dist/channel.routing.js`) and rewrites relative imports to the flat sibling names. Every non-relative import (host SDK, third-party packages, Node built-ins, native addons) stays external — nothing is vendored. A second `--flatten-dts` pass flattens `tsc`-emitted `.d.ts` files the same way.

Common scripts (from `packages/ac2-open-claw-reference`):

```sh
pnpm build               # bundle + tsc + flatten d.ts
pnpm test                # vitest, loads sources from src/
pnpm dev:link            # rebuild natives, build, install into local openclaw
pnpm dev:relink          # rebuild + `openclaw plugins update`
pnpm dev:unlink          # `openclaw plugins uninstall ac2-open-claw-reference`
```

### Releasing the plugin

The plugin is published as `@algorandfoundation/ac2-open-claw-reference` via the same `@algorandfoundation/package-releaser` pipeline as the SDK (OIDC + `publishConfig.provenance: true`, package-scoped tags `ac2-open-claw-reference@${version}`). `pnpm run release:dry-run` from the package directory exercises the pipeline without publishing.
