# OpenClaw + AC2 pairing server

A runnable example — not part of the published plugin package — showing how to deploy this plugin behind a publicly accessible OpenClaw instance on Ubuntu. Publicly accessible OpenClaw instance with the Algorand Foundation **AC2** stack: the [AC2 service](../../../ac2-cli/README.md) (`ac2-cli`) owns the wallet connection, and the [AC2 reference plugin](../../README.md) wires it into the OpenClaw agent. A user opens a token-protected web page, presses "Start pairing session", and scans the QR code (produced by `openclaw ac2 pair`) with their AC2 Controller / wallet. The pairing session stays alive for 15 minutes (configurable; `0` = forever), then auto-expires.

## Architecture

```
                          public internet
                                │
                    Cloudflare (proxied, SSL/TLS: Full)
                                │
                          :443 / :80
                                │
┌── docker ────────────────────────────────────────────────────┐
│  caddy                                                        │
│  self-signed cert (`tls internal`) ─┐                         │
│                                     ▼                         │
│  openclaw-gateway                pair-manager                 │
│  node dist/index.js gateway      HTTP :8377 QR page,          │
│  :18789 (loopback-published)     spawns `openclaw ac2 pair`   │
│        ▲                            │ control socket          │
│        │ gateway WS/RPC             ▼ (~/.ac2, shared volume) │
│  ac2-service                                                  │
│  `ac2 service start --foreground`                             │
│  owns pairing, WebRTC, identity keystore, reconnect           │
│        │ shared volume: /home/node/.openclaw                  │
└────────┼──────────────────────────────────────────────────────┘
         │ outbound only
         ▼
   Liquid Auth signaling server (WebRTC/TURN)  ←— wallet scans QR
```

Notes on why it's built this way:

- **The AC2 service owns the wallet connection.** Pairing, controller binding, the agent's identity keystore, and reconnect all live in the `ac2-service` container (the `ac2` daemon from `@algorandfoundation/ac2-cli`). It runs with `AC2_RUNTIME=openclaw-gateway`, so the daemon itself drives agent turns over the gateway WebSocket and pushes replies to the wallet — the plugin and the pair page are thin clients of its control socket (`~/.ac2/ac2d.sock`, a shared named volume). Because the service owns the connection, it survives pair-page sessions, container restarts, and re-links a returning wallet without a new scan.
- **AC2 traffic is outbound.** Pairing and chat run over Liquid Auth signaling + WebRTC, so the only inbound public ports needed are for the QR page itself. The service's WebRTC transport (`@roamhq/wrtc`, built on libwebrtc) supports TURN over TCP/TLS out of the box, so it still works from restrictive networks.
- **Cloudflare sits in front, proxied.** The A record is orange-clouded, so only Cloudflare's proxied port list works — the pair page is fronted by Caddy on 80/443 instead of being exposed directly on a nonstandard port. Caddy terminates TLS with a self-signed cert (`tls internal`); Cloudflare's SSL/TLS mode must be set to **Full** (not Flexible — that would send the pairing token to the origin in cleartext; not Full strict — that requires a CA-signed origin cert, which this setup deliberately avoids in favor of a self-signed one).
- **The pairing page session is a thin client.** "Start pairing session" spawns `openclaw ac2 pair`, which asks the running service for the QR invitation and streams it; the pair-manager keeps that client process alive for the TTL (or forever, with `PAIR_SESSION_TTL_MS=0`) and terminates it afterwards. Expiring the page session only stops offering the QR here — the service keeps its pairing cycle armed so an already-paired wallet can always re-link. "Forget pairing" runs `openclaw ac2 forget`, which clears the service's connection state and agent identities for a fresh instance.
- **Everything is baked into the image from monorepo source.** The plugin is installed at build time as a fully self-contained tarball (built by the plugin's own `pack-selfcontained.mjs` in a Docker build stage, so the bundled native addons — `@roamhq/wrtc`, `@napi-rs/keyring` — match the image platform). The `ac2-cli` service ships inside that bundle, exposed on PATH via a small `/usr/local/bin/ac2` wrapper, so service and plugin can never run different builds. The named volume `openclaw_data` is seeded from the image on first run, so plugin files, wiring, and AC2 state persist.
- **Hardening:** the node containers run as non-root `node`; all containers use `cap_drop: ALL` (caddy adds back only `NET_BIND_SERVICE`, needed to bind 80/443), `no-new-privileges`, and pids/memory/CPU limits, with tmpfs `/tmp`. The gateway port 18789 is published on host loopback only, and the pair page is not published to the host at all when caddy fronts it. The pairing page requires a secret token. The OS keychain for the service's keystore (DBus + gnome-keyring) runs inside the `ac2-service` container only.

## Prerequisites

- Ubuntu server (22.04+/26.x LTS) with a public IPv4
- Docker Engine + Compose v2 (`curl -fsSL https://get.docker.com | sh`)
- pnpm + Node.js 22+ (to build the AC2 packages from monorepo source)
- ≥ 1 GB RAM
- An API key for your model provider (asked during onboarding)
- A domain with a Cloudflare-proxied A record pointed at the server's IP

## Cloudflare setup

1. DNS record for your domain: type `A`, value = server's public IP, proxy status **Proxied** (orange cloud).
2. SSL/TLS → Overview → encryption mode: **Full** (not Flexible, not Full strict — Caddy serves a self-signed cert, which Full accepts without CA validation).
3. Set `DOMAIN=` in `.env` to that hostname before running setup.

## Deploy

```bash
# on the server
git clone <this repo> ac2 && cd ac2/packages/ac2-open-claw-reference/examples/docker-server
chmod +x scripts/setup.sh scripts/build-plugin.sh ac2-service/entry.sh
```

Edit `.env` and set at minimum:

| Variable | Required | Description |
|---|---|---|
| `DOMAIN` | optional | Cloudflare-proxied hostname (e.g. `pair.example.com`). When set, `setup.sh` starts Caddy and serves the pair page at `https://<DOMAIN>`. When blank, Caddy is not started and the pair page is available at `http://localhost:8377` — use an SSH tunnel for remote access. |
| `PAIR_SESSION_TTL_MS` | optional | Pairing session lifetime in ms (default `900000` = 15 min). Set to `0` to disable expiry: the session runs forever, until "Forget pairing". |
| `GOOGLE_API_KEY` | optional | Google AI (Gemini) API key — get one at [aistudio.google.com](https://aistudio.google.com/app/apikey). When set, onboarding runs non-interactively. Leave blank to use the interactive walkthrough. |
| `PAIR_SHOW_LOGS` | optional | Set to `true` to show the `ac2 pair` process log tail in the pairing page UI (hidden by default). Useful when debugging locally; **leave unset on public instances** to avoid leaking agent chat output through the browser. |

All other values (`OPENCLAW_GATEWAY_TOKEN`, `PAIR_TOKEN`) are generated automatically by the setup script when `.env` doesn't already contain them.

```bash
./scripts/setup.sh
```

When `GOOGLE_API_KEY` is set the script configures OpenClaw non-interactively — no onboarding walkthrough required. If `GOOGLE_API_KEY` is left blank, the traditional interactive onboarding runs instead (you will be prompted to choose a provider and paste an API key).

The script builds the AC2 packages, builds the image (which packs and installs the self-contained plugin), applies config, verifies the AC2 wiring (`plugins enable` + `ac2 setup`), and starts the stack. It prints the pairing URL at the end:

```
# With DOMAIN set (public, via Caddy + Cloudflare):
https://<DOMAIN>/?token=<PAIR_TOKEN>

# Without DOMAIN (local / private):
http://localhost:8377/?token=<PAIR_TOKEN>
  # remote: ssh -L 8377:localhost:8377 <user>@<server>
```

If `DOMAIN` is set, open the firewall for Caddy (the pair-manager port itself is never published to the host):

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## Using the pairing page

Open the URL, press **Start pairing session**. Within a few seconds the QR appears (the page polls and re-renders automatically — the service re-issues a fresh QR if a pairing attempt times out). Scan it with the AC2 Controller/wallet. The countdown shows time until auto-expiry (default 15 min, `PAIR_SESSION_TTL_MS` in `.env`; with `0` the page shows "Session stays active until you forget it" instead).

Buttons: **Start pairing session** launches/relaunches `openclaw ac2 pair` (which reports the live session if a wallet is already connected — the service owns the connection, so this is always safe); **Forget pairing** kills the page session and runs `openclaw ac2 forget` (clears the service's connection state and stored agent identities) for a fresh instance.

API (same token): `GET /api/session`, `POST /api/pair`, `POST /api/forget`, `GET /healthz` (no token).

## Day-2 operations

```bash
docker compose logs -f ac2-service           # AC2 daemon (pairing, wallet connection, runs)
docker compose logs -f pair-manager          # pairing page activity
docker compose logs -f openclaw-gateway      # gateway/agent logs
docker compose restart                       # restart stack
docker compose down && docker compose up -d --build   # rebuild after changes

# Control UI (loopback only) — from your laptop:
ssh -L 18789:127.0.0.1:18789 user@server   # then open http://127.0.0.1:18789

# Inspect the AC2 service (run these in the ac2-service container,
# which hosts the daemon process):
docker compose exec ac2-service ac2 status
docker compose exec ac2-service ac2 connections

# The plugin's view of the same state:
docker compose exec openclaw-gateway node dist/index.js ac2 status
```

To change the Liquid Auth signaling server, set `AC2_LIQUID_AUTH_SERVER` in `.env` and `docker compose up -d`.

## Troubleshooting

**QR never appears:** check `docker compose logs pair-manager` and `docker compose logs ac2-service`. If you have `PAIR_SHOW_LOGS=true` set, the page's Debug log section also shows the raw process output. Common causes: onboarding not completed (no model provider configured — the service waits for the gateway runtime before awaiting a wallet), or the Liquid Auth server unreachable (egress blocked — the container needs outbound 443).

**`ac2 status` says `idle (waiting for a runtime before awaiting a wallet)`:** the service will not await a wallet until the OpenClaw gateway is reachable. Check `docker compose ps openclaw-gateway` and the gateway logs.

**Keystore warnings / identity not persisted:** the service stores the agent's wallet-issued key via the OS keychain (`@napi-rs/keyring`). The ac2-service entrypoint starts DBus + gnome-keyring inside the container; if that fails the service degrades gracefully — pairing still works, but the wallet re-issues the agent identity on each new pairing instead of reusing it.

**Wallet can't connect after scanning (NAT/firewall):** WebRTC needs outbound UDP or TURN. The service's WebRTC stack (`@roamhq/wrtc`, built on libwebrtc) supports TURN over TCP/TLS, so it works from restrictive networks as long as outbound 443/TCP is open.

**A different wallet can't take over:** the agent stays bound to the first wallet that issued it an identity (first-controller lock, enforced by the service). Use **Forget pairing** (or `docker compose exec ac2-service ac2 forget --all`), then pair again.

**Permission errors on the volume (EACCES, uid 1000):** the containers run as uid 1000. If you switch to bind mounts, `chown -R 1000:1000` them.

**Fresh start:** `docker compose down -v` deletes the named volumes (config, auth, plugin state, AC2 connections/socket); rerun `./scripts/setup.sh`.

## Files

| Path | Purpose |
| --- | --- |
| `Dockerfile` | Two-stage build: packs the self-contained AC2 plugin (ac2-cli service + native addons bundled) from monorepo source, then bakes it into the official OpenClaw image with an `ac2` wrapper on PATH |
| `docker-compose.yml` | Hardened four-service stack (gateway, ac2-service, pair-manager, caddy), single public surface (80/443) |
| `Caddyfile` | TLS-terminating reverse proxy config (self-signed cert via `tls internal`) fronting the pair page |
| `ac2-service/entry.sh` | Starts DBus + gnome-keyring, then the AC2 daemon in the foreground |
| `pair-manager/server.js` | Dependency-free Node HTTP service managing `ac2 pair`/`forget`, TTL (0 = forever), token auth |
| `pair-manager/index.html` | QR page (client-side QR render, live polling, countdown) |
| `scripts/ac2-wrapper.sh` | `/usr/local/bin/ac2` → the ac2-cli bundled inside the installed plugin |
| `scripts/build-plugin.sh` | Builds ac2-sdk, ac2-cli, and the plugin from monorepo source (dist/ consumed by the image build) |
| `scripts/setup.sh` | One-shot server setup (env, build, onboarding, start) |
| `.env.example` | Configuration template |
