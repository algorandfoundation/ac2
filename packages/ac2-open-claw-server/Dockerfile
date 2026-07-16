# OpenClaw gateway + AC2 reference plugin, baked at build time.
#
# Based on the official image. Adds:
#   - dbus + gnome-keyring (Secret Service backend for @napi-rs/keyring)
#   - the @algorandfoundation/ac2-open-claw-reference plugin (plugin name: ac2) with its one
#     native addon (@napi-rs/keyring) rebuilt per the plugin's install guide.
#     The WebRTC transport (@roamhq/wrtc) ships prebuilt binaries — no build
#     toolchain is required.
#   - the pair-manager HTTP service (QR page in front of `openclaw ac2 pair`)
#
# The plugin is installed from a LOCAL tarball built from the monorepo source
# (packages/ac2-open-claw-server/ac2-plugin.tgz), NOT from npm — so unreleased
# fixes ship in the image. `scripts/setup.sh` builds+packs it before the image
# build; to build the image directly, run `scripts/build-plugin.sh` first.

ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest
FROM ${OPENCLAW_IMAGE}

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus \
    dbus-x11 \
    gnome-keyring \
    libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy the locally-built plugin tarball (produced from the monorepo source by
# scripts/build-plugin.sh). Build-time /tmp is a normal dir (the runtime tmpfs
# mount does not apply during `docker build`).
COPY --chown=node:node packages/ac2-open-claw-server/ac2-plugin.tgz /tmp/ac2-plugin.tgz

USER node
ENV HOME=/home/node

# 1) Install the plugin from the local tarball (built from monorepo source).
RUN node /app/dist/index.js plugins install "file:/tmp/ac2-plugin.tgz" --force

# 2) Rebuild the @napi-rs/keyring native addon (see plugin README). It ships as
#    a prebuilt N-API binary, so `npm rebuild` just wires up the right platform
#    package — no compiler needed. @roamhq/wrtc is prebuilt and needs no rebuild.
#    Installing from a manifest-id tarball places the plugin at
#    ~/.openclaw/extensions/ac2 (older npm installs used ~/.openclaw/npm/projects).
RUN set -eux; \
    PLUGIN_DIR="$( [ -d "${HOME}/.openclaw/extensions/ac2" ] && echo "${HOME}/.openclaw/extensions/ac2" \
    || find "${HOME}/.openclaw/npm/projects" -maxdepth 1 -mindepth 1 -type d \( -name 'algorandfoundation-ac2-open-claw-reference-*' -o -name '@algorandfoundation+ac2-open-claw-reference*' -o -name 'ac2-open-claw-reference*' \) | head -n1 )"; \
    test -n "$PLUGIN_DIR"; \
    npm rebuild --prefix "$PLUGIN_DIR" @napi-rs/keyring

# 3) Enable the plugin and wire channel + tools into openclaw.json.
#    This config (plus the installed plugin tree) lives in the image's
#    /home/node/.openclaw and seeds the named Docker volume on first run.
RUN node /app/dist/index.js plugins enable ac2 \
    && node /app/dist/index.js ac2 setup

# 4) Pair-manager HTTP service.
COPY --chown=node:node packages/ac2-open-claw-server/pair-manager /app/pair-manager

EXPOSE 18789 8377
