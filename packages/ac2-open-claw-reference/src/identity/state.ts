/** On-disk persistence for connections, identities, and per-thread history. */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LiquidAuthPairingCredential } from '../providers/liquid-auth.js';

/** Persisted agent identity, as issued by the wallet during bootstrap. */
export interface PersistedIdentity {
  /** Agent DID derived from the issued public key. */
  agentDid: string;
  /** Controller (wallet) DID captured from `KeyResponse.from`. */
  controllerDid: string;
  /** The raw public key the wallet returned (`KeyResponse.public_key`). */
  publicKey: string;
  /** @deprecated Legacy material; current installs persist it in the keystore. */
  material?: string;
}

/** A single persisted message within a conversation thread. */
export interface PersistedConversationMessage {
  role: 'user' | 'agent' | 'tool';
  /** Empty for `tool` entries. */
  text: string;
  at: number;
  /** Stable card id for `tool` entries (upsert key). */
  id?: string;
  /** Tool name for a `tool` entry (e.g. `exec`, `write`). */
  tool?: string;
  /** The command/invocation the agent ran, for a `tool` entry. */
  command?: string;
  /** The (possibly truncated) tool output/result text, for a `tool` entry. */
  output?: string;
}

/** A conversation thread on a connection (keyed by AC2 `thid`). */
export interface PersistedConversation {
  /** Thread id (AC2 `thid`) that identifies this conversation. */
  thid: string;
  /** Optional human-facing title (defaults to the first user message). */
  title?: string;
  /** Unix epoch (ms) the thread was first seen. */
  createdAt: number;
  /** Unix epoch (ms) the thread was last appended to. */
  updatedAt: number;
  /** Ordered message history for this thread. */
  messages: PersistedConversationMessage[];
}

/** A persisted connection keyed by Liquid Auth `requestId`. */
export interface PersistedConnection {
  /** Liquid Auth pairing id — the stable connection identifier. */
  requestId: string;
  /** Identity key the wallet granted the agent on this connection. */
  identity?: PersistedIdentity;
  /** Unix epoch (ms) the connection was first established. */
  createdAt: number;
  /** Unix epoch (ms) of the most recent activity on the connection. */
  lastActiveAt: number;
  /** Conversation threads on this connection, keyed by `thid`. */
  conversations: Record<string, PersistedConversation>;
}

/** Everything the plugin persists across restarts. */
export interface Ac2PersistedState {
  /** Durable Liquid Auth provider credential; retained until explicit forget. */
  pairing?: LiquidAuthPairingCredential;
  /** Revocation that could not be delivered yet. Never used to reconnect. */
  pendingRevocation?: {
    pairing: LiquidAuthPairingCredential;
    requestedAt: number;
  };
  /** Active `requestId` mirror (legacy single-connection field). */
  requestId?: string;
  identity?: PersistedIdentity;
  activeRequestId?: string;
  connections?: Record<string, PersistedConnection>;
}

export type Ac2StateErrorCode = 'AC2_STATE_INVALID' | 'AC2_STATE_UNREADABLE';

/** Existing state must never be mistaken for a missing state file. */
export class Ac2StateError extends Error {
  readonly code: Ac2StateErrorCode;

  constructor(code: Ac2StateErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'Ac2StateError';
    this.code = code;
  }
}

function writeAc2State(state: Ac2PersistedState): void {
  const path = statePath();
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function statePath(): string {
  const stateDirEnv = process.env['OPENCLAW_STATE_DIR']?.trim();
  const base = stateDirEnv ? stateDirEnv : join(homedir(), '.openclaw');
  return join(base, 'ac2-state.json');
}

interface StateLockOwner {
  pid: number;
  createdAt: number;
}

function writeStateLockOwner(descriptor: number): void {
  const owner: StateLockOwner = { pid: process.pid, createdAt: Date.now() };
  writeFileSync(descriptor, JSON.stringify(owner), { encoding: 'utf-8' });
}

function stateLockIsStale(lockPath: string): boolean {
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs > 5 * 60_000) return true;
    const owner = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<StateLockOwner>;
    if (!Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0) return false;
    try {
      process.kill(owner.pid!, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  } catch {
    return false;
  }
}

function tryReplaceStaleStateLock(lockPath: string): number | undefined {
  if (!stateLockIsStale(lockPath)) return undefined;
  const breakerPath = `${lockPath}.breaker`;
  let breaker: number | undefined;
  try {
    breaker = openSync(breakerPath, 'wx', 0o600);
    writeStateLockOwner(breaker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (stateLockIsStale(breakerPath)) {
        try {
          unlinkSync(breakerPath);
        } catch {
          // Another process may have reclaimed the breaker first.
        }
      }
      return undefined;
    }
    if (breaker !== undefined) {
      closeSync(breaker);
      try {
        unlinkSync(breakerPath);
      } catch {
        // Best-effort cleanup after a metadata write failure.
      }
    }
    throw error;
  }
  try {
    if (!stateLockIsStale(lockPath)) return undefined;
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      try {
        writeStateLockOwner(descriptor);
      } catch (error) {
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
        } catch {
          // Best-effort cleanup after a metadata write failure.
        }
        throw error;
      }
      return descriptor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw error;
    }
  } finally {
    closeSync(breaker);
    try {
      unlinkSync(breakerPath);
    } catch {
      // Another interrupted process may already have cleaned it up.
    }
  }
}

function waitForStateLock(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, 50));
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, 50);
    function done(): void {
      clearTimeout(timeout);
      signal!.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timeout);
      signal!.removeEventListener('abort', onAbort);
      reject(signal!.reason);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Serialize cross-process invitation creation and state migrations. */
export async function withAc2StateLock<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lockPath = `${statePath()}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    signal?.throwIfAborted();
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      try {
        writeStateLockOwner(descriptor);
      } catch (error) {
        closeSync(descriptor);
        descriptor = undefined;
        try {
          unlinkSync(lockPath);
        } catch {
          // Best-effort cleanup after a metadata write failure.
        }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      descriptor = tryReplaceStaleStateLock(lockPath);
      if (descriptor === undefined) await waitForStateLock(signal);
    }
  }
  try {
    return await operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch {
      // The lock may have been cleaned up after a process interruption.
    }
  }
}

/** Load persisted state. Only a genuinely missing file means fresh state. */
export function loadAc2State(): Ac2PersistedState {
  let raw: string;
  try {
    raw = readFileSync(statePath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Ac2StateError(
      'AC2_STATE_UNREADABLE',
      `[ac2] Unable to read persisted state at ${statePath()}`,
      { cause: error },
    );
  }
  try {
    const parsed = JSON.parse(raw) as Ac2PersistedState;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('The state root must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Ac2StateError(
      'AC2_STATE_INVALID',
      `[ac2] Persisted state at ${statePath()} is invalid JSON; refusing to replace it`,
      { cause: error },
    );
  }
}

/** Clear all persisted state (`ac2 forget`). */
export function clearAc2State(): void {
  writeAc2State({});
}

/** Clear usable pairing state while retaining a revocation retry tombstone. */
export function clearAc2StatePendingRevocation(
  pairing: LiquidAuthPairingCredential,
): void {
  writeAc2State({ pendingRevocation: { pairing, requestedAt: Date.now() } });
}

/** Remove only an unapproved/expired invitation, preserving unrelated history. */
export function discardPendingPairing(pairingId: string): void {
  const state = loadAc2State();
  if (state.pairing?.pairingId !== pairingId) return;
  const {
    pairing: _pairing,
    requestId: _requestId,
    activeRequestId: _activeRequestId,
    ...remaining
  } = state;
  writeAc2State(remaining);
}

/** Merge `patch` into the state and write it back. */
export function saveAc2State(patch: Partial<Ac2PersistedState>): void {
  const next: Ac2PersistedState = { ...loadAc2State(), ...patch };
  writeAc2State(next);
}

/** Known connections, most-recent first. */
export function listConnections(): PersistedConnection[] {
  const state = loadAc2State();
  const connections = state.connections ?? {};
  return Object.values(connections).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/** One connection by `requestId`. */
export function getConnection(requestId: string): PersistedConnection | undefined {
  return loadAc2State().connections?.[requestId];
}

/** Upsert and mark active. */
export function touchConnection(requestId: string): PersistedConnection {
  const state = loadAc2State();
  const connections = { ...state.connections };
  const now = Date.now();
  const existing = connections[requestId];
  const connection: PersistedConnection = existing
    ? { ...existing, lastActiveAt: now }
    : { requestId, createdAt: now, lastActiveAt: now, conversations: {} };
  connections[requestId] = connection;
  saveAc2State({ connections, activeRequestId: requestId, requestId });
  return connection;
}

/** Persist the identity granted on a connection. */
export function setConnectionIdentity(requestId: string, identity: PersistedIdentity): void {
  const state = loadAc2State();
  const connections = { ...state.connections };
  const now = Date.now();
  const existing = connections[requestId];
  connections[requestId] = existing
    ? { ...existing, identity, lastActiveAt: now }
    : { requestId, createdAt: now, lastActiveAt: now, conversations: {}, identity };
  saveAc2State({ connections, identity, activeRequestId: requestId, requestId });
}

/** Append a message to a thread (seeds `title` from the first user message). */
export function recordConversationMessage(
  requestId: string,
  thid: string,
  message: PersistedConversationMessage,
): PersistedConversation {
  const state = loadAc2State();
  const connections = { ...state.connections };
  const now = Date.now();
  const connection: PersistedConnection = connections[requestId] ?? {
    requestId,
    createdAt: now,
    lastActiveAt: now,
    conversations: {},
  };
  const conversations = { ...connection.conversations };
  const existing = conversations[thid];
  const conversation: PersistedConversation = existing
    ? {
        ...existing,
        updatedAt: now,
        messages: [...existing.messages, message],
        ...(existing.title === undefined && message.role === 'user'
          ? { title: message.text.slice(0, 80) }
          : {}),
      }
    : {
        thid,
        createdAt: now,
        updatedAt: now,
        messages: [message],
        ...(message.role === 'user' ? { title: message.text.slice(0, 80) } : {}),
      };
  conversations[thid] = conversation;
  connections[requestId] = { ...connection, lastActiveAt: now, conversations };
  saveAc2State({ connections, activeRequestId: requestId, requestId });
  return conversation;
}

/** Upsert a durable tool-activity record on a thread (keyed by `id`). */
export function recordToolActivity(
  requestId: string,
  thid: string,
  tool: { id: string; name?: string; command?: string; output?: string },
): PersistedConversation {
  const state = loadAc2State();
  const connections = { ...state.connections };
  const now = Date.now();
  const connection: PersistedConnection = connections[requestId] ?? {
    requestId,
    createdAt: now,
    lastActiveAt: now,
    conversations: {},
  };
  const conversations = { ...connection.conversations };
  const existing = conversations[thid] ?? {
    thid,
    createdAt: now,
    updatedAt: now,
    messages: [] as PersistedConversationMessage[],
  };
  const messages = [...existing.messages];
  const idx = messages.findIndex((m) => m.role === 'tool' && m.id === tool.id);
  if (idx !== -1) {
    const prev = messages[idx]!;
    messages[idx] = {
      ...prev,
      at: now,
      ...(tool.name ? { tool: tool.name } : {}),
      ...(tool.command ? { command: tool.command } : {}),
      ...(tool.output !== undefined ? { output: tool.output } : {}),
    };
  } else {
    messages.push({
      role: 'tool',
      text: '',
      at: now,
      id: tool.id,
      ...(tool.name ? { tool: tool.name } : {}),
      ...(tool.command ? { command: tool.command } : {}),
      ...(tool.output !== undefined ? { output: tool.output } : {}),
    });
  }
  const conversation: PersistedConversation = { ...existing, updatedAt: now, messages };
  conversations[thid] = conversation;
  connections[requestId] = { ...connection, lastActiveAt: now, conversations };
  saveAc2State({ connections, activeRequestId: requestId, requestId });
  return conversation;
}

/** Ensure a thread exists (used by `ac2/ConversationOpen`). */
export function ensureConversation(
  requestId: string,
  thid: string,
  title?: string,
): PersistedConversation {
  const state = loadAc2State();
  const connections = { ...state.connections };
  const now = Date.now();
  const connection: PersistedConnection = connections[requestId] ?? {
    requestId,
    createdAt: now,
    lastActiveAt: now,
    conversations: {},
  };
  const conversations = { ...connection.conversations };
  const existing = conversations[thid];
  const conversation: PersistedConversation = existing
    ? {
        ...existing,
        ...(title !== undefined && existing.title === undefined ? { title } : {}),
      }
    : {
        thid,
        createdAt: now,
        updatedAt: now,
        messages: [],
        ...(title !== undefined ? { title } : {}),
      };
  conversations[thid] = conversation;
  connections[requestId] = { ...connection, lastActiveAt: now, conversations };
  saveAc2State({ connections, activeRequestId: requestId, requestId });
  return conversation;
}

/** Threads on a connection, most-recent first. */
export function listConversations(requestId: string): PersistedConversation[] {
  const connection = getConnection(requestId);
  if (!connection) return [];
  return Object.values(connection.conversations).sort((a, b) => b.updatedAt - a.updatedAt);
}
