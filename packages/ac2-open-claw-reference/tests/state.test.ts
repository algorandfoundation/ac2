import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureConversation,
  getConnection,
  listConnections,
  listConversations,
  loadAc2State,
  recordConversationMessage,
  recordToolActivity,
  saveAc2State,
  clearAc2StatePendingRevocation,
  clearMatchingPendingRevocation,
  discardPendingPairing,
  discardPendingPairingIfUnestablished,
  setConnectionIdentity,
  touchConnection,
} from '../src/identity/state.js';
import { ensurePersistedPairing } from '../src/identity/pairing.js';
import { replayConversationHistory, replayConversationList } from '../src/index.js';

/** Minimal transport spy capturing the frames sent to the controller. */
function transportSpy() {
  const sent: string[] = [];
  return {
    sent,
    transport: {
      isOpen: true,
      send: (payload: string) => {
        sent.push(payload);
      },
    },
  };
}

/** Parse a single STX-prefixed control frame into its JSON object. */
function parseControlFrame(raw: string): any {
  expect(raw.charCodeAt(0)).toBe(0x02);
  return JSON.parse(raw.slice(1));
}

/**
 * The state module persists to `${OPENCLAW_STATE_DIR}/ac2-state.json`. Point it
 * at a throwaway temp dir per test so the suite never touches a real
 * `~/.openclaw` and each case starts from a clean slate.
 */
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'ac2-state-'));
  process.env['OPENCLAW_STATE_DIR'] = stateDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['OPENCLAW_STATE_DIR'];
  rmSync(stateDir, { recursive: true, force: true });
});

describe('multi-connection persistence', () => {
  it('atomically persists a mode-0600 durable pairing credential', () => {
    const pairing = {
      version: 2 as const,
      pairingId: 'pairing-1',
      role: 'provider' as const,
      credential: 'secret',
    };
    saveAc2State({ pairing });

    expect(loadAc2State().pairing).toEqual(pairing);
    expect(statSync(join(stateDir, 'ac2-state.json')).mode & 0o777).toBe(0o600);
  });

  it('retains only a revocation tombstone when local pairing is forgotten offline', () => {
    const pairing = {
      version: 2 as const,
      pairingId: 'pairing-1',
      role: 'provider' as const,
      credential: 'secret',
    };
    saveAc2State({ pairing, requestId: pairing.pairingId });
    clearAc2StatePendingRevocation(pairing);

    const state = loadAc2State();
    expect(state.pairing).toBeUndefined();
    expect(state.requestId).toBeUndefined();
    expect(state.pendingRevocation?.pairing).toEqual(pairing);
  });

  it('clears only the matching delivered revocation and preserves a replacement pairing', async () => {
    const revoked = {
      version: 2 as const,
      pairingId: 'pairing-old',
      role: 'provider' as const,
      credential: 'secret-old',
    };
    const replacement = {
      version: 2 as const,
      pairingId: 'pairing-new',
      role: 'provider' as const,
      credential: 'secret-new',
    };
    clearAc2StatePendingRevocation(revoked);
    saveAc2State({ pairing: replacement, requestId: replacement.pairingId });

    const state = await clearMatchingPendingRevocation(revoked);

    expect(state.pendingRevocation).toBeUndefined();
    expect(state.pairing).toEqual(replacement);
    expect(state.requestId).toBe(replacement.pairingId);
  });

  it('does not clear a newer revocation tombstone for a stale success response', async () => {
    const stale = {
      version: 2 as const,
      pairingId: 'pairing-same',
      role: 'provider' as const,
      credential: 'secret-old',
    };
    const current = { ...stale, credential: 'secret-new' };
    clearAc2StatePendingRevocation(current);

    const state = await clearMatchingPendingRevocation(stale);

    expect(state.pendingRevocation?.pairing).toEqual(current);
  });

  it('deduplicates concurrent invitation creation and persists before returning', async () => {
    const pairing = {
      version: 2 as const,
      pairingId: 'pairing-shared',
      role: 'provider' as const,
      credential: 'secret-shared',
    };
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        json: async () => pairing,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([
      ensurePersistedPairing('https://liquid.example'),
      ensurePersistedPairing('https://liquid.example'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0]?.pairing).toEqual(pairing);
    expect(results[1]?.pairing).toEqual(pairing);
    expect(loadAc2State().pairing).toEqual(pairing);
  });

  it('refuses to replace malformed existing state with a new invitation', async () => {
    writeFileSync(join(stateDir, 'ac2-state.json'), '{"pairing":', 'utf-8');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(() => loadAc2State()).toThrowError(
      expect.objectContaining({ code: 'AC2_STATE_INVALID' }),
    );
    await expect(ensurePersistedPairing('https://liquid.example')).rejects.toMatchObject({
      code: 'AC2_STATE_INVALID',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discards only an unapproved invitation and preserves connection history', () => {
    const pairing = {
      version: 2 as const,
      pairingId: 'pairing-pending',
      role: 'provider' as const,
      credential: 'secret-pending',
    };
    saveAc2State({ pairing, requestId: pairing.pairingId });
    touchConnection('older-established-pairing');

    discardPendingPairing(pairing.pairingId);

    const state = loadAc2State();
    expect(state.pairing).toBeUndefined();
    expect(state.connections?.['older-established-pairing']).toBeDefined();
  });

  it('discards only the exact unauthorized invitation that remains unestablished', async () => {
    const stale = {
      version: 2 as const,
      pairingId: 'pairing-pending',
      role: 'provider' as const,
      credential: 'secret-old',
    };
    const replacement = { ...stale, credential: 'secret-new' };
    saveAc2State({ pairing: replacement, requestId: replacement.pairingId });

    await expect(discardPendingPairingIfUnestablished(stale)).resolves.toBe(false);
    expect(loadAc2State().pairing).toEqual(replacement);

    await expect(discardPendingPairingIfUnestablished(replacement)).resolves.toBe(true);
    expect(loadAc2State().pairing).toBeUndefined();
  });

  it('retains an unauthorized pairing after it has established connection history', async () => {
    const pairing = {
      version: 2 as const,
      pairingId: 'pairing-established',
      role: 'provider' as const,
      credential: 'secret',
    };
    saveAc2State({ pairing, requestId: pairing.pairingId });
    touchConnection(pairing.pairingId);

    await expect(discardPendingPairingIfUnestablished(pairing)).resolves.toBe(false);
    expect(loadAc2State().pairing).toEqual(pairing);
  });

  it('touchConnection creates a connection and marks it active', () => {
    const conn = touchConnection('req-1');
    expect(conn.requestId).toBe('req-1');
    expect(conn.conversations).toEqual({});
    const state = loadAc2State();
    expect(state.activeRequestId).toBe('req-1');
    expect(state.requestId).toBe('req-1');
    expect(getConnection('req-1')).toBeDefined();
  });

  it('tracks multiple independent connections, most-recently-active first', async () => {
    touchConnection('req-1');
    await new Promise((resolve) => setTimeout(resolve, 2));
    touchConnection('req-2');
    const connections = listConnections();
    expect(connections.map((c) => c.requestId)).toEqual(['req-2', 'req-1']);
  });

  it('persists agent key metadata scoped to a connection', () => {
    setConnectionIdentity('req-1', {
      agentDid: 'did:key:zAgent',
      controllerDid: 'did:key:zController',
      publicKey: 'pub-1',
      material: 'secret-1',
    });
    const conn = getConnection('req-1');
    expect(conn?.identity?.publicKey).toBe('pub-1');
    expect(conn?.identity?.material).toBe('secret-1');
    // Mirrored into the legacy top-level identity for backwards compatibility.
    expect(loadAc2State().identity?.publicKey).toBe('pub-1');
  });
});

describe('multi-conversation (thid) history', () => {
  it('keeps separate per-thid history within one connection', () => {
    recordConversationMessage('req-1', 'thread-a', { role: 'user', text: 'hi A', at: 1 });
    recordConversationMessage('req-1', 'thread-a', { role: 'agent', text: 'hello A', at: 2 });
    recordConversationMessage('req-1', 'thread-b', { role: 'user', text: 'hi B', at: 3 });

    const conversations = listConversations('req-1');
    expect(conversations).toHaveLength(2);

    const threadA = conversations.find((c) => c.thid === 'thread-a');
    expect(threadA?.messages.map((m) => m.text)).toEqual(['hi A', 'hello A']);
    // First user message seeds the title.
    expect(threadA?.title).toBe('hi A');

    const threadB = conversations.find((c) => c.thid === 'thread-b');
    expect(threadB?.messages).toHaveLength(1);
  });

  it('most-recently-updated conversation sorts first', () => {
    recordConversationMessage('req-1', 'thread-a', { role: 'user', text: 'a', at: 1 });
    recordConversationMessage('req-1', 'thread-b', { role: 'user', text: 'b', at: 2 });
    // Re-touch thread-a so it becomes most recent.
    recordConversationMessage('req-1', 'thread-a', { role: 'user', text: 'a2', at: 3 });
    expect(listConversations('req-1').map((c) => c.thid)).toEqual(['thread-a', 'thread-b']);
  });

  it('isolates conversations across connections', () => {
    recordConversationMessage('req-1', 'thread-x', { role: 'user', text: 'one', at: 1 });
    recordConversationMessage('req-2', 'thread-x', { role: 'user', text: 'two', at: 2 });
    expect(listConversations('req-1')).toHaveLength(1);
    expect(listConversations('req-2')).toHaveLength(1);
    expect(getConnection('req-1')?.conversations['thread-x']?.messages[0]?.text).toBe('one');
    expect(getConnection('req-2')?.conversations['thread-x']?.messages[0]?.text).toBe('two');
  });

  it('ensureConversation registers a titled thread with no messages', () => {
    const convo = ensureConversation('req-1', 'thread-new', 'My chat');
    expect(convo.thid).toBe('thread-new');
    expect(convo.title).toBe('My chat');
    expect(convo.messages).toEqual([]);
    // Surfaces in the connection's conversation list.
    expect(listConversations('req-1').map((c) => c.thid)).toContain('thread-new');
  });

  it('ensureConversation is idempotent and can name a previously-untitled thread', () => {
    // A message-seeded thread with no title (agent-authored first message).
    recordConversationMessage('req-1', 'thread-y', { role: 'agent', text: 'hi', at: 1 });
    expect(getConnection('req-1')?.conversations['thread-y']?.title).toBeUndefined();

    // Opening it with a title names it without dropping existing history.
    ensureConversation('req-1', 'thread-y', 'Named later');
    const convo = getConnection('req-1')?.conversations['thread-y'];
    expect(convo?.title).toBe('Named later');
    expect(convo?.messages).toHaveLength(1);
  });
});

describe('conversation restore (control-frame replay)', () => {
  it('replayConversationList advertises every persisted thread as one frame', () => {
    recordConversationMessage('req-1', 'thread-a', { role: 'user', text: 'hi A', at: 1 });
    recordConversationMessage('req-1', 'thread-b', { role: 'user', text: 'hi B', at: 2 });

    const { sent, transport } = transportSpy();
    replayConversationList(transport, 'req-1');

    expect(sent).toHaveLength(1);
    const frame = parseControlFrame(sent[0]!);
    expect(frame.t).toBe('conversations');
    expect(frame.threads.map((t: any) => t.thid).sort()).toEqual(['thread-a', 'thread-b']);
    // Titles (seeded from the first user message) ride along for the switcher.
    const a = frame.threads.find((t: any) => t.thid === 'thread-a');
    expect(a.title).toBe('hi A');
  });

  it('replayConversationList sends nothing when the connection has no threads', () => {
    const { sent, transport } = transportSpy();
    replayConversationList(transport, 'req-empty');
    expect(sent).toHaveLength(0);
  });

  it('replayConversationHistory replays a thread, normalizing agent → assistant', () => {
    recordConversationMessage('req-1', 'thread-a', { role: 'user', text: 'hello', at: 1 });
    recordConversationMessage('req-1', 'thread-a', { role: 'agent', text: 'hi there', at: 2 });

    const { sent, transport } = transportSpy();
    replayConversationHistory(transport, 'req-1', 'thread-a');

    expect(sent).toHaveLength(1);
    const frame = parseControlFrame(sent[0]!);
    expect(frame.t).toBe('history');
    expect(frame.thid).toBe('thread-a');
    expect(frame.messages).toEqual([
      { role: 'user', text: 'hello', at: 1 },
      { role: 'assistant', text: 'hi there', at: 2 },
    ]);
  });

  it('replayConversationHistory sends nothing for an unknown / empty thread', () => {
    ensureConversation('req-1', 'thread-empty');
    const { sent, transport } = transportSpy();
    replayConversationHistory(transport, 'req-1', 'thread-empty');
    replayConversationHistory(transport, 'req-1', 'thread-missing');
    expect(sent).toHaveLength(0);
  });

  it('both replays no-op without a requestId', () => {
    const { sent, transport } = transportSpy();
    replayConversationList(transport, undefined);
    replayConversationHistory(transport, undefined, 'thread-a');
    expect(sent).toHaveLength(0);
  });

  it('replayConversationHistory replays tool entries verbatim', () => {
    recordConversationMessage('req-1', 'thread-a', { role: 'user', text: 'run ls', at: 1 });
    recordToolActivity('req-1', 'thread-a', {
      id: 'tool-1',
      name: 'exec',
      command: 'ls -la',
      output: 'a\nb',
    });

    const { sent, transport } = transportSpy();
    replayConversationHistory(transport, 'req-1', 'thread-a');

    const frame = parseControlFrame(sent[0]!);
    expect(frame.t).toBe('history');
    expect(frame.messages).toContainEqual({ role: 'user', text: 'run ls', at: 1 });
    const tool = frame.messages.find((m: any) => m.role === 'tool');
    expect(tool).toMatchObject({
      role: 'tool',
      id: 'tool-1',
      name: 'exec',
      command: 'ls -la',
      output: 'a\nb',
    });
  });
});

describe('tool-activity persistence', () => {
  it('records a new tool entry on a thread', () => {
    recordToolActivity('req-1', 'thread-a', { id: 'tool-1', name: 'exec', command: 'ls' });
    const convo = getConnection('req-1')?.conversations['thread-a'];
    const tool = convo?.messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ id: 'tool-1', tool: 'exec', command: 'ls' });
  });

  it('upserts the same tool id in place, merging only supplied fields', () => {
    recordToolActivity('req-1', 'thread-a', { id: 'tool-1', name: 'exec', command: 'ls' });
    // A later streamed update carries only output — must keep the command.
    recordToolActivity('req-1', 'thread-a', { id: 'tool-1', output: 'file-a' });
    const tools = (getConnection('req-1')?.conversations['thread-a']?.messages ?? []).filter(
      (m) => m.role === 'tool',
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: 'tool-1', command: 'ls', output: 'file-a' });
  });
});
