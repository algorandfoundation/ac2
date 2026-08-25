#!/usr/bin/env bash
# AC2 one-line setup for OpenClaw.
#
#   curl -fsSL https://raw.githubusercontent.com/algorandfoundation/ac2/master/install.sh | bash
#
# Installs the AC2 plugin (@algorandfoundation/ac2-open-claw-reference)
# into an existing OpenClaw install — the plugin bundles the AC2 service,
# so no separate @algorandfoundation/ac2-cli install is needed. Then wires
# the plugin into openclaw.json, restarts the gateway, and starts wallet
# pairing when run in a terminal.
#
# Requires OpenClaw to already be installed and set up; the script fails
# early if it is not.
#
# Safe to re-run: every step is idempotent or degrades to an update.
set -euo pipefail

# Unversioned spec follows the stable (@latest) release channel; @next is
# reserved for canary pre-releases.
PLUGIN_SPEC='@algorandfoundation/ac2-open-claw-reference'
PLUGIN_ID='ac2'

log() { printf '\033[1;36m[ac2 setup]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31m[ac2 setup]\033[0m %s\n' "$*" >&2
  exit 1
}

# --- 1. Prerequisites: Node.js 22+ and npm ---------------------------------

command -v node >/dev/null 2>&1 ||
  fail 'Node.js 22 or newer is required. Install it from https://nodejs.org and re-run this script.'

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] 2>/dev/null ||
  fail "Node.js 22 or newer is required, found $(node --version)."

command -v npm >/dev/null 2>&1 ||
  fail 'npm was not found on PATH (it normally ships with Node.js).'

# --- 2. OpenClaw ------------------------------------------------------------

command -v openclaw >/dev/null 2>&1 ||
  fail "OpenClaw is required but was not found on PATH. Install and set it up first (see https://docs.openclaw.ai/), e.g. 'npm install -g openclaw@latest', then re-run this script."

log "Found OpenClaw: $(openclaw --version 2>/dev/null | head -n 1 || echo 'version unknown')"

# --- 3. The AC2 plugin (bundles the AC2 service) ----------------------------

log "Installing the AC2 plugin ($PLUGIN_SPEC)…"
if ! openclaw plugins install "$PLUGIN_SPEC"; then
  # Most likely already installed — fall back to an update so a re-run
  # of this script also moves an existing install to the newest canary.
  log 'Install did not apply cleanly; trying an update of the existing plugin instead…'
  openclaw plugins update "$PLUGIN_ID"
fi

log 'Enabling the plugin…'
openclaw plugins enable "$PLUGIN_ID"

log 'Writing the channel + tools wiring into openclaw.json…'
openclaw ac2 setup

log 'Restarting the OpenClaw gateway so it picks up the plugin…'
if ! openclaw gateway restart; then
  log 'Gateway restart failed. If this is a brand-new OpenClaw install, finish its first-run setup (see https://docs.openclaw.ai/), then run: openclaw gateway restart && openclaw ac2 pair'
  exit 1
fi

# --- 4. Pair a wallet -------------------------------------------------------

if [ -t 1 ]; then
  log 'Everything is installed. Starting wallet pairing — scan the QR code with your AC2 wallet (Ctrl+C to skip).'
  openclaw ac2 pair
else
  log "Everything is installed. Run 'openclaw ac2 pair' in a terminal to connect your wallet."
fi
