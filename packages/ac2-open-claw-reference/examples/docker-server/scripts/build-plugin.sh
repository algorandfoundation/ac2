#!/usr/bin/env bash
# Build the AC2 workspace packages (ac2-sdk, ac2-cli, and the OpenClaw
# reference plugin) from the monorepo source. Their dist/ output is what the
# Docker build's plugin-builder stage packs into the self-contained plugin
# tarball (see the Dockerfile) — the packing itself happens inside Docker so
# the bundled native addons match the image's platform, not the host's.
#
# Run this before `docker compose build` when building the image directly.
# `scripts/setup.sh` calls it automatically.
set -euo pipefail

# Repo layout: packages/ac2-open-claw-reference/examples/docker-server/scripts/build-plugin.sh
SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SERVER_DIR/../../../.." && pwd)"

command -v pnpm >/dev/null || { echo "pnpm is required to build the AC2 packages"; exit 1; }

cd "$REPO_ROOT"

echo "==> Installing workspace dependencies"
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install

echo "==> Building ac2-sdk, ac2-cli, and the AC2 plugin from source"
pnpm --filter @algorandfoundation/ac2-sdk \
     --filter @algorandfoundation/ac2-cli \
     --filter @algorandfoundation/ac2-open-claw-reference \
     build
