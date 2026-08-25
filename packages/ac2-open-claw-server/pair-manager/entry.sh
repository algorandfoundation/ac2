#!/bin/sh
# Entrypoint for the pair-manager service.
#
# Starts a session DBus + gnome-keyring Secret Service so @napi-rs/keyring
# (used by the AC2 plugin's keystore) has an OS keychain to talk to.
# Best-effort: if the keyring cannot start, the plugin degrades gracefully
# (agent identity is re-requested from the wallet on each pairing) and the
# pair-manager still runs.
set -u

run_manager() {
  exec node /app/pair-manager/server.js
}

if command -v dbus-run-session >/dev/null 2>&1 && command -v gnome-keyring-daemon >/dev/null 2>&1; then
  exec dbus-run-session -- sh -c '
    # Unlock the "login" keyring with an empty password (headless container).
    eval "$(printf "" | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)" || true
    eval "$(gnome-keyring-daemon --start --components=secrets 2>/dev/null)" || true
    export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK 2>/dev/null || true
    exec node /app/pair-manager/server.js
  '
else
  echo "[pair-entry] dbus/gnome-keyring not available; keystore will be degraded" >&2
  run_manager
fi
