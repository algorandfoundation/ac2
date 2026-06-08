/** On-disk persistence for connections, identities, and per-thread history. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
  /** Active `requestId` mirror (legacy single-connection field). */
  requestId?: string;
  identity?: PersistedIdentity;
  activeRequestId?: string;
  connections?: Record<string, PersistedConnection>;
}

function statePath(): string {
  const stateDirEnv = process.env['OPENCLAW_STATE_DIR']?.trim();
  const base = stateDirEnv ? stateDirEnv : join(homedir(), '.openclaw');
  return join(base, 'ac2-state.json');
}

/** Load persisted state (returns `{}` if missing/corrupt). */
export function loadAc2State(): Ac2PersistedState {
  try {
    const raw = readFileSync(statePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Ac2PersistedState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Clear all persisted state (`ac2 forget`). */
export function clearAc2State(): void {
  const path = statePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({}, null, 2), 'utf-8');
  } catch {
    // best-effort
  }
}

/** Merge `patch` into the state and write it back. */
export function saveAc2State(patch: Partial<Ac2PersistedState>): void {
  const path = statePath();
  const next: Ac2PersistedState = { ...loadAc2State(), ...patch };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2), 'utf-8');
  } catch {
    // best-effort
  }
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
