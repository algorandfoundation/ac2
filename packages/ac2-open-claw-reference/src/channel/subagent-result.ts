/**
 * Read a finished sub-agent ("background task") child's final result text.
 *
 * The host's own completion delivery cannot reach our standalone pairing CLI:
 * the direct announce performs an in-process gateway `agent` dispatch that
 * requires a gateway request scope we never have (no HTTP/WS listener), so it
 * fails and retries until it gives up — the child's answer never arrives. That
 * is the root cause behind "the task completes without any response".
 *
 * However, the child *does* persist its final assistant text to its own session
 * transcript, and the public plugin SDK exposes readers for it. We use them to
 * fetch the real answer from the child's session and deliver it ourselves over
 * our DataChannel (see `subagent-hooks.ts`). This is best-effort: if the text
 * cannot be read we fall back to a plain lifecycle notice.
 */

import {
  getSessionEntry,
  listSessionEntries,
  readLatestAssistantTextFromSessionTranscript,
  readRecentUserAssistantTextForSession,
  resolveStorePath,
} from 'openclaw/plugin-sdk/session-store-runtime';
import { getRuntimeConfig } from 'openclaw/plugin-sdk/config-runtime';

/** A host sub-agent child session key: `agent:<agentId>:subagent:<uuid>`. */
const SUBAGENT_SESSION_KEY_RE = /^agent:[^:]+:subagent:/;

/**
 * Normalize a session key for equality matching against the value the host
 * persists in a child entry's `spawnedBy`.
 *
 * CRITICAL: the host lower-cases session keys when it stores them (see
 * `normalizeSessionKeyPreservingOpaquePeerIds` in the host runtime — everything
 * is folded to lower-case *except* opaque peer segments for the `signal` and
 * `matrix` channels, which are the only registered case-preserving peers). Our
 * channel is `ac2`, so the ENTIRE key — including the mixed-case `did:key:`
 * controller DID — is stored lower-cased (e.g. the host's own warning logs show
 * `requester=ac2:did:key:z6mkk…:default`). Meanwhile the `parentSessionKey` we
 * capture on a task is the ORIGINAL mixed-case `ac2:did:key:z6MkkMu6…:default`.
 *
 * Comparing those two raw strings with `!==` never matched, so
 * `discoverChildSessionKey` silently found nothing every poll and the child's
 * result was never delivered. Folding both sides to lower-case before comparing
 * mirrors the host normalization for `ac2` keys and fixes the match.
 */
function normalizeSessionKeyForMatch(key: string | undefined): string {
  return (key ?? '').trim().toLowerCase();
}

/**
 * Test whether a child entry's recorded owner (`spawnedBy` / `parentSessionKey`)
 * refers to the requester `wantNormalized` (already lower-cased via
 * {@link normalizeSessionKeyForMatch}).
 *
 * CRITICAL: the host does not store the owner as the bare requester session key.
 * It namespaces it with the child's agent, i.e. it persists
 * `agent:<agentId>:<requesterSessionKey>` (the failing run's diagnostics showed
 * `want="ac2:did:key:z6mkk…:default"` but stored
 * `owners=[agent:main:ac2:did:key:z6mkk…:default]`). So even after the
 * lower-casing fix, a raw `===` never matched and discovery kept spinning.
 *
 * We therefore accept a match when the normalized owner equals `want` OR when
 * stripping a single leading `agent:<agentId>:` namespace prefix yields `want`.
 * Our requester keys are always `ac2:…` (never start with `agent:`), so the
 * prefix strip is unambiguous.
 */
function ownerMatchesRequester(
  ownerRaw: string | undefined,
  wantNormalized: string,
): boolean {
  if (!wantNormalized) return false;
  const owner = normalizeSessionKeyForMatch(ownerRaw);
  if (!owner) return false;
  if (owner === wantNormalized) return true;
  const stripped = owner.replace(/^agent:[^:]+:/, '');
  return stripped === wantNormalized;
}

/**
 * Extract the agent id embedded in a child session key. Host child keys look
 * like `agent:<agentId>:subagent:<uuid>` (or `agent:<agentId>:acp:<uuid>`); the
 * agent id is the second `:`-delimited segment.
 */
function agentIdFromSessionKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const match = /^agent:([^:]+):/.exec(key);
  return match?.[1];
}

/**
 * Resolve the on-disk session store path EXACTLY as the host does when it
 * persists a sub-agent's timing/transcript (`persistSubagentSessionTiming`):
 * `resolveStorePath(getRuntimeConfig().session?.store, { agentId })`.
 *
 * This must match the host, otherwise our reads look in the wrong directory.
 * We previously passed `undefined` for the configured store, which silently
 * resolves the DEFAULT store — so any deployment that sets a custom
 * `session.store` in its OpenClaw config would never let us observe the child's
 * completion status or read its result, and the completion poller would spin
 * until it timed out. Reading the store from the same in-process runtime-config
 * snapshot the host uses fixes that.
 */
function resolveChildStorePath(agentId?: string): string | undefined {
  let configuredStore: string | undefined;
  try {
    const cfg = getRuntimeConfig() as { session?: { store?: string } } | undefined;
    configuredStore = cfg?.session?.store;
  } catch {
    configuredStore = undefined;
  }
  return resolveStorePath(configuredStore, agentId ? { agentId } : {});
}

/** Terminal (finished) sub-agent run statuses persisted on the child entry. */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'killed', 'timeout']);

/** A snapshot of a child sub-agent session's persisted run status. */
export interface ChildSessionStatus {
  /** True once the child's session entry exists in the store. */
  exists: boolean;
  /** True once the run has finished (terminal status or an `endedAt` stamp). */
  ended: boolean;
  /** The persisted run status, when written. */
  status?: 'running' | 'done' | 'failed' | 'killed' | 'timeout';
}

/**
 * Read a child sub-agent session's *persisted* run status from the session
 * store. This is the reliable, gateway-independent completion signal: when a
 * sub-agent run ends, the host writes `status`/`endedAt` onto the child's
 * `SessionEntry` (see `persistSubagentSessionTiming` in the host runtime), even
 * though its own announce/delivery path fails in our no-gateway pairing CLI.
 *
 * `readConsistency: 'latest'` forces a fresh read so we observe the completion
 * write promptly rather than a cached in-memory snapshot.
 */
export function readChildSessionStatus(opts: {
  childSessionKey?: string;
  agentId?: string;
}): ChildSessionStatus {
  const sessionKey = opts.childSessionKey;
  if (!sessionKey) return { exists: false, ended: false };
  const agentId = opts.agentId ?? agentIdFromSessionKey(sessionKey);
  try {
    const storePath = resolveChildStorePath(agentId);
    const entry = getSessionEntry({
      sessionKey,
      readConsistency: 'latest',
      ...(agentId ? { agentId } : {}),
      ...(storePath ? { storePath } : {}),
    });
    if (!entry) return { exists: false, ended: false };
    const status = entry.status;
    const ended =
      (typeof status === 'string' && TERMINAL_STATUSES.has(status)) ||
      typeof entry.endedAt === 'number';
    return { exists: true, ended, ...(status ? { status } : {}) };
  } catch {
    return { exists: false, ended: false };
  }
}

/**
 * Discover a spawned child's session key by scanning the agent's session store
 * for a sub-agent session whose `spawnedBy` equals the parent session key.
 *
 * This is the fallback used when the accepted `sessions_spawn` envelope never
 * surfaced a `childSessionKey` to us (e.g. the reply dispatcher did not invoke
 * `onToolResult` for the spawn, or wrapped the accepted payload in an
 * unexpected shape). The host stamps the requester/parent session key onto every
 * child entry's `spawnedBy`, so a match is precise to this exact conversation.
 * When several children were spawned from the same parent we prefer the most
 * recently started one that has not already been claimed (`excludeKeys`), so
 * concurrent tasks on one thread don't collide.
 */
export function discoverChildSessionKey(opts: {
  parentSessionKey?: string;
  agentId?: string;
  excludeKeys?: Iterable<string>;
}): string | undefined {
  const parentSessionKey = opts.parentSessionKey?.trim();
  if (!parentSessionKey) return undefined;
  const wantSpawnedBy = normalizeSessionKeyForMatch(parentSessionKey);
  const exclude = new Set(opts.excludeKeys ?? []);
  try {
    const agentId = opts.agentId;
    const storePath = resolveChildStorePath(agentId);
    const entries = listSessionEntries({
      ...(agentId ? { agentId } : {}),
      ...(storePath ? { storePath } : {}),
    });
    let bestKey: string | undefined;
    let bestAt = -1;
    for (const summary of entries) {
      const sessionKey = summary?.sessionKey;
      const entry = summary?.entry as
        | {
            spawnedBy?: string;
            parentSessionKey?: string;
            startedAt?: number;
            lastInteractionAt?: number;
          }
        | undefined;
      if (!sessionKey || !entry) continue;
      if (!SUBAGENT_SESSION_KEY_RE.test(sessionKey)) continue;
      // The host records the requester on `spawnedBy` and/or `parentSessionKey`
      // (both are checked by its own `sessionEntryIsOwnedByRequester`); match
      // either, normalized to mirror the host's lower-casing of `ac2` keys and
      // tolerating the `agent:<agentId>:` namespace prefix the host prepends.
      const owner =
        ownerMatchesRequester(entry.spawnedBy, wantSpawnedBy) ||
        ownerMatchesRequester(entry.parentSessionKey, wantSpawnedBy);
      if (!owner) continue;
      if (exclude.has(sessionKey)) continue;
      const at =
        typeof entry.startedAt === 'number'
          ? entry.startedAt
          : typeof entry.lastInteractionAt === 'number'
            ? entry.lastInteractionAt
            : 0;
      if (at >= bestAt) {
        bestAt = at;
        bestKey = sessionKey;
      }
    }
    return bestKey;
  } catch {
    return undefined;
  }
}

/**
 * Human-readable summary of the sub-agent child sessions currently in the store,
 * used purely for diagnostics when `discoverChildSessionKey` fails to find a
 * match. Reports how many sub-agent entries exist and (normalized) `spawnedBy` /
 * `parentSessionKey` owners we saw, next to the owner we were looking for — so a
 * single failing run makes any residual mismatch (store path, agent id, key
 * shape) immediately obvious in the logs. Best-effort; never throws.
 */
export function describeSubagentCandidates(opts: {
  parentSessionKey?: string;
  agentId?: string;
}): string {
  const want = normalizeSessionKeyForMatch(opts.parentSessionKey);
  try {
    const agentId = opts.agentId;
    const storePath = resolveChildStorePath(agentId);
    const entries = listSessionEntries({
      ...(agentId ? { agentId } : {}),
      ...(storePath ? { storePath } : {}),
    });
    const owners: string[] = [];
    let subagentCount = 0;
    for (const summary of entries) {
      const sessionKey = summary?.sessionKey;
      if (!sessionKey || !SUBAGENT_SESSION_KEY_RE.test(sessionKey)) continue;
      subagentCount += 1;
      const entry = summary?.entry as
        | { spawnedBy?: string; parentSessionKey?: string }
        | undefined;
      const owner = entry?.spawnedBy ?? entry?.parentSessionKey;
      if (owner) owners.push(normalizeSessionKeyForMatch(owner));
    }
    const sample = owners.slice(0, 5).join(', ') || '(none)';
    return `store=${storePath ?? '(default)'} subagentEntries=${subagentCount} want="${want}" owners=[${sample}]`;
  } catch (err) {
    return `diagnostics unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Fetch the child's final assistant text from its session transcript. Returns
 * `undefined` when the session/text cannot be resolved (any failure is
 * swallowed — the caller falls back to a lifecycle notice).
 */
export async function readChildResultText(opts: {
  childSessionKey?: string;
  agentId?: string;
}): Promise<string | undefined> {
  const sessionKey = opts.childSessionKey;
  if (!sessionKey) return undefined;
  const agentId = opts.agentId ?? agentIdFromSessionKey(sessionKey);

  try {
    const storePath = resolveChildStorePath(agentId);
    const read = {
      sessionKey,
      readConsistency: 'latest' as const,
      ...(agentId ? { agentId } : {}),
      ...(storePath ? { storePath } : {}),
    };

    // Preferred: resolve the transcript file and read its latest assistant text.
    const entry = getSessionEntry(read);
    const sessionFile = entry?.sessionFile;
    if (sessionFile) {
      const latest = await readLatestAssistantTextFromSessionTranscript(sessionFile);
      const text = latest?.text?.trim();
      if (text) return text;
    }

    // Fallback: pull recent turns for the session key and take the last
    // assistant message (this reader does not accept `readConsistency`).
    const recent = await readRecentUserAssistantTextForSession({
      sessionKey,
      limit: 20,
      ...(agentId ? { agentId } : {}),
      ...(storePath ? { storePath } : {}),
    });
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const item = recent[i];
      if (item?.role === 'assistant') {
        const text = item.text?.trim();
        if (text) return text;
      }
    }
  } catch {
    // Any read failure → no text; the caller posts a lifecycle notice instead.
  }
  return undefined;
}
