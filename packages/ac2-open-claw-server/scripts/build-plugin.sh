#!/usr/bin/env bash
# Build the AC2 reference plugin from the monorepo source and pack it into
# packages/ac2-open-claw-server/ac2-plugin.tgz, which the Dockerfile installs.
#
# Run this before `docker compose build` when building the image directly.
# `scripts/setup.sh` calls it automatically.
set -euo pipefail

# Repo layout: packages/ac2-open-claw-server/scripts/build-plugin.sh
SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SERVER_DIR/../.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/packages/ac2-open-claw-reference"
OUT_TGZ="$SERVER_DIR/ac2-plugin.tgz"

command -v pnpm >/dev/null || { echo "pnpm is required to build the plugin"; exit 1; }

echo "==> Building AC2 plugin from source ($PLUGIN_DIR)"
pnpm --filter @algorandfoundation/ac2-open-claw-reference install --frozen-lockfile >/dev/null 2>&1 || \
  pnpm --filter @algorandfoundation/ac2-open-claw-reference install
pnpm --filter @algorandfoundation/ac2-open-claw-reference build

echo "==> Packing plugin tarball"
PACK_DIR="$(mktemp -d)"
trap 'rm -rf "$PACK_DIR"' EXIT
TGZ="$(node "$PLUGIN_DIR/scripts/pack-plugin.mjs" --pack-destination "$PACK_DIR" | tail -n1)"
test -f "$TGZ"
cp "$TGZ" "$OUT_TGZ"
echo "==> Wrote $OUT_TGZ"
