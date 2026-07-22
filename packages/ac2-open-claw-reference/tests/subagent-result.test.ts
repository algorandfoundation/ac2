import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the host session-store readers so we can exercise `readChildResultText`
// deterministically without a real on-disk agent store.
const mocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
  listSessionEntries: vi.fn(() => [] as unknown[]),
  readLatest: vi.fn(),
  readRecent: vi.fn(),
  resolveStorePath: vi.fn(() => '/tmp/store'),
}));

vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: mocks.getSessionEntry,
  listSessionEntries: mocks.listSessionEntries,
  readLatestAssistantTextFromSessionTranscript: mocks.readLatest,
  readRecentUserAssistantTextForSession: mocks.readRecent,
  resolveStorePath: mocks.resolveStorePath,
}));

vi.mock('openclaw/plugin-sdk/config-runtime', () => ({
  getRuntimeConfig: () => ({}),
}));

import { discoverChildSessionKey, readChildResultText } from '../src/channel/subagent-result.js';

describe('readChildResultText (child transcript reader)', () => {
  beforeEach(() => {
    mocks.getSessionEntry.mockReset();
    mocks.readLatest.mockReset();
    mocks.readRecent.mockReset();
    mocks.resolveStorePath.mockReset();
    mocks.resolveStorePath.mockReturnValue('/tmp/store');
  });

  it('returns undefined without a child session key', async () => {
    expect(await readChildResultText({})).toBeUndefined();
    expect(mocks.getSessionEntry).not.toHaveBeenCalled();
  });

  it('reads the latest assistant text via the transcript file and derives agentId', async () => {
    mocks.getSessionEntry.mockReturnValue({ sessionFile: '/tmp/store/child.jsonl' });
    mocks.readLatest.mockResolvedValue({ text: '  the real answer  ' });

    const text = await readChildResultText({
      childSessionKey: 'agent:main:subagent:abc-123',
    });

    expect(text).toBe('the real answer');
    // agentId parsed from the child session key.
    expect(mocks.getSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 'agent:main:subagent:abc-123', agentId: 'main' }),
    );
    expect(mocks.readLatest).toHaveBeenCalledWith('/tmp/store/child.jsonl');
    expect(mocks.readRecent).not.toHaveBeenCalled();
  });

  it('falls back to the most recent assistant turn when no transcript file', async () => {
    mocks.getSessionEntry.mockReturnValue(undefined);
    mocks.readRecent.mockResolvedValue([
      { role: 'user', text: 'do it' },
      { role: 'assistant', text: 'first' },
      { role: 'assistant', text: 'final answer' },
    ]);

    const text = await readChildResultText({ childSessionKey: 'child:x', agentId: 'a1' });
    expect(text).toBe('final answer');
  });

  it('returns undefined (swallows errors) when the readers throw', async () => {
    mocks.getSessionEntry.mockImplementation(() => {
      throw new Error('store unavailable');
    });
    const text = await readChildResultText({ childSessionKey: 'agent:main:subagent:z' });
    expect(text).toBeUndefined();
  });

  it('returns undefined when neither reader yields assistant text', async () => {
    mocks.getSessionEntry.mockReturnValue({ sessionFile: '/tmp/store/child.jsonl' });
    mocks.readLatest.mockResolvedValue(undefined);
    mocks.readRecent.mockResolvedValue([{ role: 'user', text: 'only user' }]);

    const text = await readChildResultText({ childSessionKey: 'agent:main:subagent:z' });
    expect(text).toBeUndefined();
  });
});

describe('discoverChildSessionKey (spawnedBy owner match)', () => {
  beforeEach(() => {
    mocks.listSessionEntries.mockReset();
    mocks.resolveStorePath.mockReset();
    mocks.resolveStorePath.mockReturnValue('/tmp/store');
  });

  // The host lower-cases `ac2` session keys when it stores them, so a child's
  // `spawnedBy` is the lower-cased requester key while our task keeps the
  // original mixed-case DID. Discovery must match case-insensitively.
  it('matches a lower-cased stored spawnedBy against a mixed-case parent key', () => {
    mocks.listSessionEntries.mockReturnValue([
      {
        sessionKey: 'agent:main:subagent:child-1',
        entry: {
          spawnedBy: 'ac2:did:key:z6mkkmu6h9us:default',
          startedAt: 100,
        },
      },
    ]);

    const key = discoverChildSessionKey({
      parentSessionKey: 'ac2:did:key:z6MkkMu6H9Us:default',
    });
    expect(key).toBe('agent:main:subagent:child-1');
  });

  // The host does not store the bare requester key — it namespaces it with the
  // child's agent, e.g. `agent:main:ac2:did:key:…:default`. Discovery must strip
  // that `agent:<agentId>:` prefix before comparing (this was the real cause of
  // finished background tasks never delivering their answer).
  it('matches an owner stored with the `agent:<agentId>:` namespace prefix', () => {
    mocks.listSessionEntries.mockReturnValue([
      {
        sessionKey: 'agent:main:subagent:child-ns',
        entry: {
          spawnedBy: 'agent:main:ac2:did:key:z6mkkmu6h9us:default',
          startedAt: 100,
        },
      },
    ]);

    const key = discoverChildSessionKey({
      parentSessionKey: 'ac2:did:key:z6MkkMu6H9Us:default',
    });
    expect(key).toBe('agent:main:subagent:child-ns');
  });

  it('matches a namespaced owner on the host `parentSessionKey` field too', () => {
    mocks.listSessionEntries.mockReturnValue([
      {
        sessionKey: 'agent:main:subagent:child-ns2',
        entry: {
          parentSessionKey: 'agent:main:ac2:did:key:z6mkkmu6h9us:default',
          startedAt: 7,
        },
      },
    ]);
    const key = discoverChildSessionKey({
      parentSessionKey: 'ac2:did:key:z6MkkMu6H9Us:default',
    });
    expect(key).toBe('agent:main:subagent:child-ns2');
  });

  it('also matches the host `parentSessionKey` field, case-insensitively', () => {
    mocks.listSessionEntries.mockReturnValue([
      {
        sessionKey: 'agent:main:subagent:child-2',
        entry: { parentSessionKey: 'ac2:did:key:z6mkkmu6h9us:default', startedAt: 5 },
      },
    ]);
    const key = discoverChildSessionKey({
      parentSessionKey: 'ac2:did:key:z6MkkMu6H9Us:default',
    });
    expect(key).toBe('agent:main:subagent:child-2');
  });

  it('prefers the most recent unclaimed child for the same parent', () => {
    mocks.listSessionEntries.mockReturnValue([
      {
        sessionKey: 'agent:main:subagent:old',
        entry: { spawnedBy: 'ac2:did:key:zabc:default', startedAt: 1 },
      },
      {
        sessionKey: 'agent:main:subagent:claimed',
        entry: { spawnedBy: 'ac2:did:key:zabc:default', startedAt: 9 },
      },
      {
        sessionKey: 'agent:main:subagent:new',
        entry: { spawnedBy: 'ac2:did:key:zABC:default', startedAt: 5 },
      },
    ]);
    const key = discoverChildSessionKey({
      parentSessionKey: 'ac2:did:key:zabc:default',
      excludeKeys: ['agent:main:subagent:claimed'],
    });
    // 'claimed' is excluded and 'old' is older than 'new'.
    expect(key).toBe('agent:main:subagent:new');
  });

  it('ignores entries owned by a different parent', () => {
    mocks.listSessionEntries.mockReturnValue([
      {
        sessionKey: 'agent:main:subagent:other',
        entry: { spawnedBy: 'ac2:did:key:zsomeoneelse:default', startedAt: 1 },
      },
    ]);
    const key = discoverChildSessionKey({
      parentSessionKey: 'ac2:did:key:zme:default',
    });
    expect(key).toBeUndefined();
  });

  it('returns undefined without a parent session key', () => {
    const key = discoverChildSessionKey({});
    expect(key).toBeUndefined();
    expect(mocks.listSessionEntries).not.toHaveBeenCalled();
  });
});
