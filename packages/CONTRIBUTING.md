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
    └── ac2-sdk/            TypeScript SDK (@algorandfoundation/ac2-sdk).
        ├── src/
        │   ├── client.ts           Ac2Client (symmetric request/response).
        │   ├── index.ts            Top-level barrel.
        │   ├── schema/             Types, type guards, decoder, validator.
        │   ├── protocol/           Message factories, builders, handlers.
        │   ├── transport/          Ac2Transport, RTC + in-memory adapters.
        │   └── signaling/          Ac2ChannelProvider interface.
        ├── tests/
        ├── README.md
        └── EXTENDING.md
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
