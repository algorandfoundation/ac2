/**
 * Local git-signing bridge: a mode-0600 Unix domain socket served by the
 * process that holds the active AC2 session. The `ac2-ssh-sign` shim (git's
 * `gpg.ssh.program`) connects here to route SSHSIG payloads to the wallet.
 *
 * Wire protocol: one newline-delimited JSON request per connection
 * (`GitSignBridgeRequest`), answered with one newline-delimited JSON
 * response (`GitSignBridgeResponse`).
 */

import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

import type { PluginConfig } from '../session/contracts.js';
import type { SignDeps } from '../session/flows.js';
import { NoActiveSessionError } from '../session/manager.js';
import { resolveOpenClawConfigPath } from '../setup/config.js';
import { gitSignFlow, type GitSignParams, type GitSignResult } from './sign-flow.js';

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface GitSignBridgeRequest {
  v: 1;
  payload_base64: string;
  namespace?: string;
  /** Authorized-key line (or raw base64 key) git was configured to sign with. */
  expected_public_key?: string;
}

export type GitSignBridgeResponse = GitSignResult | { status: 'error'; error: string };

/** Directory for AC2 runtime state (socket, shim wrapper, allowed signers). */
export function resolveAc2StateDir(): string {
  return join(dirname(resolveOpenClawConfigPath()), 'ac2');
}

/** Socket path; `AC2_GIT_SIGN_SOCKET` overrides (used by tests and the shim). */
export function gitSignSocketPath(): string {
  const fromEnv = process.env['AC2_GIT_SIGN_SOCKET']?.trim();
  if (fromEnv) return fromEnv;
  return join(resolveAc2StateDir(), 'git-sign.sock');
}

export interface GitSignBridgeDeps extends SignDeps {
  socketPath?: string;
}

let activeServer: Server | null = null;
let activeSocketPath: string | null = null;

function parseRequest(line: string): GitSignBridgeRequest | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<GitSignBridgeRequest>;
    if (parsed?.v !== 1 || typeof parsed.payload_base64 !== 'string') return undefined;
    return parsed as GitSignBridgeRequest;
  } catch {
    return undefined;
  }
}

async function handleRequest(
  request: GitSignBridgeRequest,
  config: PluginConfig,
  deps: GitSignBridgeDeps,
): Promise<GitSignBridgeResponse> {
  const params: GitSignParams = {
    payload_base64: request.payload_base64,
    ...(request.namespace !== undefined ? { namespace: request.namespace } : {}),
    ...(request.expected_public_key !== undefined
      ? { expected_public_key: request.expected_public_key }
      : {}),
  };
  try {
    return await gitSignFlow(params, config, deps);
  } catch (err) {
    if (err instanceof NoActiveSessionError) {
      return { status: 'rejected', reason: err.code };
    }
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

function wireConnection(socket: Socket, config: PluginConfig, deps: GitSignBridgeDeps): void {
  let buffered = '';
  let handled = false;
  socket.setEncoding('utf8');
  socket.on('error', () => {
    /* client went away; nothing to do */
  });
  socket.on('data', (chunk: string) => {
    if (handled) return;
    buffered += chunk;
    if (buffered.length > MAX_REQUEST_BYTES) {
      handled = true;
      socket.end(`${JSON.stringify({ status: 'error', error: 'request_too_large' })}\n`);
      return;
    }
    const newline = buffered.indexOf('\n');
    if (newline === -1) return;
    handled = true;
    const request = parseRequest(buffered.slice(0, newline));
    if (!request) {
      socket.end(`${JSON.stringify({ status: 'error', error: 'malformed_request' })}\n`);
      return;
    }
    void handleRequest(request, config, deps).then((response) => {
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
}

/**
 * Start (or reuse) the git-signing bridge. Idempotent — safe to call every
 * time a session goes active. Signing requests arriving while no session is
 * active are rejected with `no_active_session` by the flow itself.
 */
export function ensureGitSignBridge(config: PluginConfig, deps: GitSignBridgeDeps = {}): Server {
  const socketPath = deps.socketPath ?? gitSignSocketPath();
  if (activeServer?.listening && activeSocketPath === socketPath) {
    return activeServer;
  }
  if (activeServer) {
    try {
      activeServer.close();
    } catch {
      /* best-effort teardown of a stale server */
    }
    activeServer = null;
    activeSocketPath = null;
  }

  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(socketPath); // remove a stale socket from a previous run
  } catch {
    /* fine if it did not exist */
  }

  const server = createServer((socket) => wireConnection(socket, config, deps));
  server.on('error', () => {
    /* surfaced to callers via `listening` state on the next ensure */
  });
  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      /* best-effort tightening; the parent dir is already 0700 */
    }
  });
  server.unref?.();

  activeServer = server;
  activeSocketPath = socketPath;
  return server;
}

/** Stop the bridge and remove its socket (tests / shutdown). */
export async function stopGitSignBridge(): Promise<void> {
  const server = activeServer;
  const socketPath = activeSocketPath;
  activeServer = null;
  activeSocketPath = null;
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (socketPath) {
    try {
      unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
  }
}
