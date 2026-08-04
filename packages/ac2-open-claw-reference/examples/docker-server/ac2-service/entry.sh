#!/bin/sh
# Entrypoint for the ac2-service container: the AC2 daemon (the process that
# owns the wallet connection — Liquid Auth pairing, WebRTC channel, identity
# keystore, reconnect) running in the foreground as the container's main
# process. The `openclaw-gateway` runtime adapter (AC2_RUNTIME, set in
# docker-compose.yml) drives agent turns over the gateway WebSocket.
#
# Starts a session DBus + gnome-keyring Secret Service first so the daemon's
# keystore (@napi-rs/keyring) has an OS keychain to talk to. Best-effort: if
# the keyring cannot start, the daemon degrades gracefully (the agent identity
# is re-requested from the wallet on each pairing) and still runs.
set -u

AC2_HOME="${AC2_HOME:-$HOME/.ac2}"
export AC2_HOME
mkdir -p "$AC2_HOME"
chmod 700 "$AC2_HOME" 2>/dev/null || true

# `ac2 service start --foreground` writes no pidfile (only the detached mode
# does), but `ac2 service status` / `stop` — and humans debugging inside this
# container — expect one. $$ survives the exec, so writing it just before is
# correct. Done inside the dbus session below too, where $$ is the inner shell.
run_daemon() {
  echo $$ > "$AC2_HOME/ac2d.pid"
  exec ac2 service start --foreground
}

if command -v dbus-run-session >/dev/null 2>&1 && command -v gnome-keyring-daemon >/dev/null 2>&1; then
  exec dbus-run-session -- sh -c '
    # Create/unlock the "login" keyring with an empty password (headless
    # container). The password fed to --unlock MUST be newline-terminated
    # (`printf "\n"`, not `printf ""`) — without the newline gnome-keyring
    # never creates the keyring and the Secret Service stays collection-less,
    # which leaves the AC2 keystore blocked on a prompt nothing can answer.
    eval "$(printf "\n" | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)" || true
    eval "$(gnome-keyring-daemon --start --components=secrets 2>/dev/null)" || true
    export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK 2>/dev/null || true
    echo $$ > "$AC2_HOME/ac2d.pid"
    exec ac2 service start --foreground
  '
else
  echo "[ac2-service] dbus/gnome-keyring not available; keystore will be degraded" >&2
  run_daemon
fi
