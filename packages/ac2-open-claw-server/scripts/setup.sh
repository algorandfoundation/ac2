#!/usr/bin/env bash
# One-shot setup on the Ubuntu server. Run from the repo root:
#   ./scripts/setup.sh
#
# Steps:
#   1. generate .env (tokens) if missing
#   2. build the image (openclaw + AC2 plugin + @napi-rs/keyring rebuild)
#   3. run OpenClaw onboarding (interactive: provider/API key)
#   4. set gateway config + verify plugin wiring
#   5. start the stack
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "docker is required"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 is required"; exit 1; }

sed_in_place() {
  local expression="$1"
  local file="$2"

  sed -i.bak "$expression" "$file"
  rm -f "${file}.bak"
}

# --- 1. .env ---------------------------------------------------------------
if [[ ! -f .env ]]; then
  echo "==> Generating .env"
  cp .env.example .env
  sed_in_place "s/^OPENCLAW_GATEWAY_TOKEN=.*/OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)/" .env
  sed_in_place "s/^PAIR_TOKEN=.*/PAIR_TOKEN=$(openssl rand -hex 24)/" .env
else
  echo "==> .env exists, keeping it"
fi
# shellcheck disable=SC1091
set -a; source .env; set +a

# --- 2. build ---------------------------------------------------------------
echo "==> Building image (installs the AC2 plugin + rebuilds @napi-rs/keyring)"
docker compose build openclaw-gateway

# --- 3. onboarding / provider config (first run only) ----------------------
# The named volume is seeded from the image on first use; onboarding writes
# provider auth + gateway token into it. Run before the gateway starts.
#
# If GOOGLE_API_KEY is set in .env the setup is fully non-interactive:
# the gateway config and provider key are written via `config set` and the
# onboarding walkthrough is skipped entirely.
# If GOOGLE_API_KEY is not set, the traditional interactive walkthrough runs.
ONBOARDED=$(docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  -e "try{require('fs').accessSync('/home/node/.openclaw/.onboarded');console.log('yes')}catch{console.log('no')}" 2>/dev/null | tail -n1 || echo no)
if [[ "$ONBOARDED" != "yes" ]]; then
  # Baking the AC2 plugin install into the image (Dockerfile) auto-adds it to
  # plugins.allow, turning that array into a restrictive allowlist. Left in
  # place, it blocks onboarding from enabling any other plugin — including
  # the built-in model-provider plugins (e.g. Gemini) — with "<provider>
  # plugin is disabled (blocked by allowlist)". Clear it before onboarding
  # runs so provider selection isn't blocked; AC2 stays enabled via its own
  # plugins.entries record.
  docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
    dist/index.js config unset plugins.allow || true

  if [[ -n "${GOOGLE_API_KEY:-}" ]]; then
    echo "==> Auto-configuring OpenClaw (non-interactive; provider config applied below)"
    # First-run only needs the plugins.allow clear already done above;
    # the actual provider key/model are written unconditionally in step 3b.
    :
  else
    echo "==> Running OpenClaw onboarding (interactive)"
    docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
      dist/index.js onboard --mode local --no-install-daemon || {
        echo "Onboarding failed or was cancelled. Re-run: ./scripts/setup.sh"; exit 1; }
  fi

  docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
    -e "require('fs').writeFileSync('/home/node/.openclaw/.onboarded','1')"
else
  echo "==> Onboarding already completed, skipping"
fi

echo "==> Applying gateway config"
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js config set --batch-json '[
    {"path":"gateway.mode","value":"local"},
    {"path":"gateway.bind","value":"lan"}
  ]'

# --- 3b. Google provider config (always applied; idempotent) ----------------
# Runs on every setup.sh invocation so changes to GOOGLE_API_KEY or
# GOOGLE_MODEL in .env are picked up without resetting the .onboarded marker.
#
# Config paths follow the OpenClaw model-catalog schema:
#   - models.providers.google.apiKey  — merges onto the built-in "google"
#     provider entry (catalog mode is "merge" by default, so baseUrl/api/model
#     list from the built-in catalog are preserved).
#   - agents.defaults.model           — selects the default model in
#     "<provider>/<model>" form, e.g. "google/gemini-2.5-pro". GOOGLE_MODEL in
#     .env is the bare model id; the "google/" prefix is added here.
# Written via `config set --batch-json`, which validates against the live schema
# before writing. This step is non-fatal: if a future image changes the schema,
# it warns and continues instead of aborting the whole setup.
if [[ -n "${GOOGLE_API_KEY:-}" ]]; then
  echo "==> Applying Google provider config"
  docker compose run --rm --no-deps \
    -e GOOGLE_API_KEY="${GOOGLE_API_KEY}" \
    -e GOOGLE_MODEL="${GOOGLE_MODEL:-}" \
    --entrypoint node openclaw-gateway \
    -e "const cp=require('child_process');
        const cfg=[{path:'models.providers.google.apiKey',value:process.env.GOOGLE_API_KEY}];
        if(process.env.GOOGLE_MODEL) cfg.push({path:'agents.defaults.model',value:'google/'+process.env.GOOGLE_MODEL});
        cp.execFileSync('node',['/app/dist/index.js','config','set','--batch-json',JSON.stringify(cfg)],{stdio:'inherit'})" \
    || echo "WARNING: Google provider config failed (schema mismatch?). Continuing; configure the provider via 'config set' or onboarding if the gateway can't reach a model."
fi

echo "==> Verifying AC2 plugin wiring"
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js plugins enable ac2 || true
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js ac2 setup || true

# --- 4. start ---------------------------------------------------------------
echo "==> Starting stack"
if [[ -n "${DOMAIN:-}" ]]; then
  docker compose --profile caddy up -d
else
  docker compose up -d
fi

echo
echo "============================================================"
if [[ -n "${DOMAIN:-}" ]]; then
  echo " Pairing page:"
  echo "   https://${DOMAIN}/?token=${PAIR_TOKEN}"
  echo
  echo " Open it, press 'Start pairing session', scan the QR."
  echo " Sessions auto-expire after $(( ${PAIR_SESSION_TTL_MS:-900000} / 60000 )) minutes."
  echo
  echo " Firewall reminder (ufw):"
  echo "   sudo ufw allow 80/tcp"
  echo "   sudo ufw allow 443/tcp"
  echo
  echo " Cloudflare reminder: DNS record proxied (orange cloud), SSL/TLS mode = Full."
else
  echo " Pairing page (local / no TLS):"
  echo "   http://localhost:8377/?token=${PAIR_TOKEN}"
  echo
  echo " Open it, press 'Start pairing session', scan the QR."
  echo " Sessions auto-expire after $(( ${PAIR_SESSION_TTL_MS:-900000} / 60000 )) minutes."
  echo
  echo " For remote access, SSH-tunnel the port first:"
  echo "   ssh -L 8377:localhost:8377 <user>@<server>"
  echo " then open http://localhost:8377/?token=${PAIR_TOKEN}"
fi
echo "============================================================"
