#!/usr/bin/env node
/**
 * pair-manager — tiny HTTP service in front of `openclaw ac2 pair`.
 *
 * Responsibilities:
 *   - spawn `openclaw ac2 pair` on demand and keep the process (and thus the
 *     AC2 session it hosts) alive for a fixed TTL (default 15 minutes)
 *   - parse the pairing payload from stdout ("Pairing URL: <payload>") and
 *     serve it as a scannable QR code on a token-protected web page
 *   - expose start / status / forget endpoints
 *
 * No npm dependencies: Node built-ins only. QR rendering happens client-side.
 *
 * Env:
 *   PAIR_TOKEN            required. shared secret; page/API need ?token=...
 *   PAIR_PORT             listen port                     (default 8377)
 *   PAIR_BIND             listen address                  (default 0.0.0.0)
 *   PAIR_SESSION_TTL_MS   session lifetime                (default 900000 = 15 min)
 *   OPENCLAW_ENTRY        openclaw entry point            (default /app/dist/index.js)
 *   PAIR_SHOW_LOGS        expose child process log tail   (default false)
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PAIR_TOKEN = process.env.PAIR_TOKEN || '';
const PAIR_PORT = Number(process.env.PAIR_PORT || 8377);
const PAIR_BIND = process.env.PAIR_BIND || '0.0.0.0';
const SESSION_TTL_MS = Number(process.env.PAIR_SESSION_TTL_MS || 15 * 60 * 1000);
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY || '/app/dist/index.js';
const PAIR_SHOW_LOGS = process.env.PAIR_SHOW_LOGS === 'true';
const LOG_TAIL_MAX = 200;

if (!PAIR_TOKEN) {
  console.error('[pair-manager] FATAL: PAIR_TOKEN is not set. Refusing to start unauthenticated.');
  process.exit(1);
}

/** ---- session state ------------------------------------------------ */

const session = {
  state: 'idle', // idle | starting | waiting | expired | error
  child: null,
  childAlive: false,
  qrPayload: null,
  paired: false,
  startedAt: null,
  expiresAt: null,
  ttlTimer: null,
  logTail: [],
  lastError: null,
};

function log(msg) {
  console.log(`[pair-manager] ${new Date().toISOString()} ${msg}`);
}

function pushLog(line) {
  const trimmed = line.replace(/\s+$/, '');
  if (!trimmed) return;
  session.logTail.push(trimmed);
  if (session.logTail.length > LOG_TAIL_MAX) session.logTail.shift();
}

function parseOutput(chunk) {
  const text = chunk.toString('utf8');
  for (const line of text.split('\n')) pushLog(line);

  // The invitation block contains: "Pairing URL: <qrPayload>"
  // Re-pair cycles print a fresh invitation, so always keep the LAST match.
  const matches = [...text.matchAll(/Pairing URL:\s*(\S+)/g)];
  if (matches.length > 0) {
    const payload = matches[matches.length - 1][1];
    if (payload !== session.qrPayload) {
      session.qrPayload = payload;
      session.paired = false;
      if (session.state === 'starting') session.state = 'waiting';
      log(`new pairing payload captured (${payload.slice(0, 48)}...)`);
    }
  }

  // Opportunistic pairing detection (log line may or may not reach stdout).
  if (/paired and active/i.test(text)) {
    session.paired = true;
    log('channel reported paired and active');
  }
}

function clearTtlTimer() {
  if (session.ttlTimer) {
    clearTimeout(session.ttlTimer);
    session.ttlTimer = null;
  }
}

function killChild(signal = 'SIGTERM') {
  const child = session.child;
  if (child && session.childAlive) {
    try {
      child.kill(signal);
      setTimeout(() => {
        if (session.childAlive) {
          try { child.kill('SIGKILL'); } catch { /* gone */ }
        }
      }, 5000).unref();
    } catch { /* already gone */ }
  }
}

function startSession() {
  if (session.state === 'starting' || (session.state === 'waiting' && session.childAlive)) {
    return; // already running
  }
  clearTtlTimer();
  killChild();

  session.state = 'starting';
  session.qrPayload = null;
  session.paired = false;
  session.lastError = null;
  session.logTail = [];
  session.startedAt = Date.now();
  session.expiresAt = session.startedAt + SESSION_TTL_MS;

  log(`starting: node ${OPENCLAW_ENTRY} ac2 pair (ttl ${SESSION_TTL_MS} ms)`);
  const child = spawn('node', [OPENCLAW_ENTRY, 'ac2', 'pair'], {
    cwd: path.dirname(OPENCLAW_ENTRY),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  session.child = child;
  session.childAlive = true;

  child.stdout.on('data', parseOutput);
  child.stderr.on('data', parseOutput);

  child.on('exit', (code, sig) => {
    session.childAlive = false;
    log(`ac2 pair process exited (code=${code} signal=${sig})`);
    // If it exited before ever producing a QR, that's an error.
    // If we already have a QR, the session may be hosted gateway-side or the
    // wallet may already be connected — keep showing state until TTL.
    if (!session.qrPayload && session.state !== 'expired') {
      session.state = 'error';
      session.lastError = `openclaw ac2 pair exited early (code=${code}, signal=${sig}) — see log tail`;
    }
  });

  child.on('error', (err) => {
    session.childAlive = false;
    session.state = 'error';
    session.lastError = `failed to spawn openclaw: ${err.message}`;
    log(session.lastError);
  });

  session.ttlTimer = setTimeout(() => {
    log('session TTL reached — terminating pairing process');
    session.state = 'expired';
    killChild();
  }, SESSION_TTL_MS);
  session.ttlTimer.unref();
}

function runOneShot(args) {
  return new Promise((resolve) => {
    const child = spawn('node', [OPENCLAW_ENTRY, ...args], {
      cwd: path.dirname(OPENCLAW_ENTRY),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: -1, out: String(err) }));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 60_000).unref();
  });
}

async function forgetSession() {
  clearTtlTimer();
  killChild();
  session.state = 'idle';
  session.qrPayload = null;
  session.paired = false;
  session.startedAt = null;
  session.expiresAt = null;
  const res = await runOneShot(['ac2', 'forget']);
  pushLog(`> openclaw ac2 forget → exit ${res.code}`);
  for (const line of res.out.split('\n')) pushLog(line);
  log(`ac2 forget completed (exit ${res.code})`);
  return res;
}

/** ---- auth ---------------------------------------------------------- */

function tokenOk(req, url) {
  const presented = url.searchParams.get('token') || req.headers['x-pair-token'] || '';
  const a = Buffer.from(String(presented));
  const b = Buffer.from(PAIR_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** ---- http ---------------------------------------------------------- */

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  if (!tokenOk(req, url)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('Forbidden: missing or invalid token');
  }

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      return res.end(INDEX_HTML);
    }

    if (req.method === 'GET' && url.pathname === '/api/session') {
      return sendJson(res, 200, {
        state: session.state,
        qrPayload: session.qrPayload,
        paired: session.paired,
        childAlive: session.childAlive,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        now: Date.now(),
        ttlMs: SESSION_TTL_MS,
        lastError: PAIR_SHOW_LOGS ? session.lastError : undefined,
        logTail: PAIR_SHOW_LOGS ? session.logTail : undefined,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      startSession();
      return sendJson(res, 200, { ok: true, state: session.state });
    }

    if (req.method === 'POST' && url.pathname === '/api/forget') {
      const r = await forgetSession();
      return sendJson(res, 200, { ok: r.code === 0, exitCode: r.code });
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    log(`request error: ${err.stack || err}`);
    sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(PAIR_PORT, PAIR_BIND, () => {
  log(`listening on http://${PAIR_BIND}:${PAIR_PORT} (ttl ${SESSION_TTL_MS} ms)`);
});

process.on('SIGTERM', () => { killChild(); process.exit(0); });
process.on('SIGINT', () => { killChild(); process.exit(0); });
