# OpenClaw gateway + AC2 service + AC2 reference plugin, baked at build time.
#
# Based on the official OpenClaw image. Adds:
#   - dbus + gnome-keyring (Secret Service backend for @napi-rs/keyring, used
#     by the AC2 service's keystore)
#   - the @algorandfoundation/ac2-open-claw-reference plugin (plugin name: ac2),
#     installed as a SELF-CONTAINED tarball: its node_modules — including the
#     @algorandfoundation/ac2-cli service and every native addon — are bundled
#     inside, so the install is a no-op npm-wise and nothing is fetched from
#     the registry (the unpublished workspace deps could not be, anyway).
#   - an `ac2` wrapper on PATH pointing at the ac2-cli bundled in the plugin,
#     so the compose stack (and operators) can run the AC2 service directly.
#   - the ac2-service entrypoint (foreground AC2 daemon behind dbus/keyring)
#   - the pair-manager HTTP service (QR page in front of `openclaw ac2 pair`)
#
# Everything is built from the monorepo source, NOT from npm — so unreleased
# fixes ship in the image. The build has two stages:
#   1. plugin-builder: runs the plugin's own pack-selfcontained.mjs, which
#      materialises the full node_modules (native binaries included) FOR THIS
#      IMAGE'S PLATFORM — this is why it runs in Docker and not on the host.
#      It needs the packages' dist/ output: run `scripts/build-plugin.sh`
#      (or `scripts/setup.sh`, which calls it) on the host first.
#   2. the final image: installs that tarball into OpenClaw and wires it up.

ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest

# --- Stage 1: assemble the self-contained plugin tarball --------------------
FROM ${OPENCLAW_IMAGE} AS plugin-builder

USER root
# --force: the base image already ships pnpm/pnpx shims, which npm otherwise
# refuses to overwrite (EEXIST).
RUN npm install -g pnpm@10 --force \
    && mkdir -p /build && chown node:node /build
USER node
WORKDIR /build

# Workspace manifests: pnpm pack (inside pack-selfcontained.mjs) needs them to
# rewrite `workspace:*` / `catalog:` specifiers to concrete versions.
COPY --chown=node:node pnpm-workspace.yaml package.json ./
COPY --chown=node:node build/package.json build/package.json

# The three AC2 packages, with their host-built dist/ output.
COPY --chown=node:node packages/ac2-sdk packages/ac2-sdk
COPY --chown=node:node packages/ac2-cli packages/ac2-cli
COPY --chown=node:node packages/ac2-open-claw-reference packages/ac2-open-claw-reference

# `pnpm pack` can only rewrite `workspace:*` specifiers against an installed
# node_modules; rewrite these throwaway builder copies instead (drop devDeps,
# pin workspace refs to their concrete versions) so no `pnpm install` is needed.
COPY --chown=node:node packages/ac2-open-claw-reference/examples/docker-server/scripts/prepare-builder-manifests.mjs /build/prepare-builder-manifests.mjs
RUN node /build/prepare-builder-manifests.mjs /build

# Produces a tarball with a fully materialised node_modules (npm install runs
# here with scripts enabled, so wrtc/keyring natives are fetched for linux).
RUN node packages/ac2-open-claw-reference/scripts/pack-selfcontained.mjs --out /build/out \
    && cp /build/out/*.tgz /build/ac2-plugin.tgz

# --- Stage 2: the runtime image ----------------------------------------------
FROM ${OPENCLAW_IMAGE}

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus \
    dbus-x11 \
    gnome-keyring \
    libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*

# Keep the tarball under /app so it is available at runtime too: scripts/setup.sh
# reinstalls it into the persistent volume on upgrades (the compose services
# mount /tmp as tmpfs, so it must not live there).
COPY --from=plugin-builder --chown=node:node /build/ac2-plugin.tgz /app/ac2-plugin.tgz

# `ac2` on PATH → the ac2-cli bundled inside the installed plugin, so the
# service container and operators use the exact same build the plugin uses.
COPY packages/ac2-open-claw-reference/examples/docker-server/scripts/ac2-wrapper.sh /usr/local/bin/ac2
RUN chmod 755 /usr/local/bin/ac2

USER node
ENV HOME=/home/node

# The AC2 service's runtime dir (control socket, pidfile). Created here, owned
# by node, so the ac2_home named volume seeds from it with the right ownership
# (a bare named volume over a non-existent path would be root-owned).
RUN mkdir -p /home/node/.ac2 && chmod 700 /home/node/.ac2

# 1) Install the self-contained plugin (bundled node_modules make the host's
#    `npm install --ignore-scripts` a no-op: nothing to fetch, nothing to build,
#    so no native rebuild step is needed either).
RUN node /app/dist/index.js plugins install "file:/app/ac2-plugin.tgz" --force

# 2) The `ac2` wrapper must resolve the bundled CLI — fail the build otherwise.
RUN test -f /home/node/.openclaw/extensions/ac2/node_modules/@algorandfoundation/ac2-cli/dist/cli.js

# 3) Enable the plugin and wire channel + tools into openclaw.json.
#    This config (plus the installed plugin tree) lives in the image's
#    /home/node/.openclaw and seeds the named Docker volume on first run.
RUN node /app/dist/index.js plugins enable ac2 \
    && node /app/dist/index.js ac2 setup

# 4) AC2 service entrypoint + pair-manager HTTP service.
COPY --chown=node:node packages/ac2-open-claw-reference/examples/docker-server/ac2-service /app/ac2-service
COPY --chown=node:node packages/ac2-open-claw-reference/examples/docker-server/pair-manager /app/pair-manager

EXPOSE 18789 8377
