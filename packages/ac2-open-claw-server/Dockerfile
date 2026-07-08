# OpenClaw gateway + AC2 reference plugin, baked at build time.
#
# Based on the official image. Adds:
#   - dbus + gnome-keyring (Secret Service backend for @napi-rs/keyring)
#   - the @algorandfoundation/ac2-open-claw-reference plugin (plugin name: ac2) with its one
#     native addon (@napi-rs/keyring) rebuilt per the plugin's install guide.
#     The WebRTC transport (@roamhq/wrtc) ships prebuilt binaries — no build
#     toolchain is required.
#   - the pair-manager HTTP service (QR page in front of `openclaw ac2 pair`)

ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest
FROM ${OPENCLAW_IMAGE}

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus \
    dbus-x11 \
    gnome-keyring \
    libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy the plugin manifest so the install step can read the current version
# straight from the monorepo — no hardcoded version needed.
COPY --chown=root:root packages/ac2-open-claw-reference/package.json /tmp/plugin-pkg.json

USER node
ENV HOME=/home/node

# 1) Install the plugin at the version declared in the monorepo package.json
#    (npm install --ignore-scripts under the hood).
RUN VERSION="$(node -p "require('/tmp/plugin-pkg.json').version")" && \
    node /app/dist/index.js plugins install "npm:@algorandfoundation/ac2-open-claw-reference@${VERSION}"

# 2) Rebuild the @napi-rs/keyring native addon (see plugin README). It ships as
#    a prebuilt N-API binary, so `npm rebuild` just wires up the right platform
#    package — no compiler needed. @roamhq/wrtc is prebuilt and needs no rebuild.
RUN set -eux; \
    PLUGIN_DIR="$(find "${HOME}/.openclaw/npm/projects" -maxdepth 1 -mindepth 1 -type d \( -name 'algorandfoundation-ac2-open-claw-reference-*' -o -name '@algorandfoundation+ac2-open-claw-reference*' -o -name 'ac2-open-claw-reference*' \) | head -n1)"; \
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
