/**
 * `ac2-stream` control-frame protocol. Each frame is `STX` (`\u0002`) + JSON:
 * `preview` / `finalize` / `discard` / `tool` / `conversations` / `history` /
 * `notice`.
 */

/** Transport a control frame can be written to. */
export interface Sendable {
  send: (payload: string) => void;
  isOpen: boolean;
}

export const AC2_STREAM_CONTROL_PREFIX = '\u0002';

export type Ac2LivePhase = 'thinking' | 'tool' | 'typing';

/** Severity for an out-of-band `notice` control frame. */
export type Ac2NoticeLevel = 'info' | 'warning' | 'error';

/** An out-of-band advisory the wallet renders as a banner (never a chat bubble). */
export interface Ac2Notice {
  /** Machine-readable code so the wallet can special-case a notice. */
  code: string;
  /** Severity; defaults to `warning` on the wire when omitted. */
  level?: Ac2NoticeLevel;
  /** Optional short heading. */
  title?: string;
  /** Human-facing body text. */
  text: string;
}

/** Write one control frame. Best-effort, never throws. */
export function sendStreamControl(transport: Sendable, frame: Record<string, unknown>): void {
  if (!transport.isOpen) return;
  try {
    transport.send(AC2_STREAM_CONTROL_PREFIX + JSON.stringify(frame));
  } catch {
    // advisory — must never break the turn.
  }
}

/** Emit a live-preview frame (`text` is cumulative for `typing`). */
export function sendPreview(
  transport: Sendable,
  thid: string,
  phase: Ac2LivePhase,
  opts?: { text?: string; detail?: string },
): void {
  sendStreamControl(transport, {
    t: 'preview',
    thid,
    phase,
    ...(opts?.text !== undefined ? { text: opts.text } : {}),
    ...(opts?.detail ? { detail: opts.detail } : {}),
  });
}

/** Finalize the live preview as the final reply. */
export function sendFinalize(transport: Sendable, thid: string, mid: string, text: string): void {
  sendStreamControl(transport, { t: 'finalize', thid, mid, text });
}

/** Discard the live preview. */
export function sendDiscard(transport: Sendable, thid: string): void {
  sendStreamControl(transport, { t: 'discard', thid });
}

/** Emit a durable tool-activity card (de-duped by `id`). */
export function sendToolActivity(
  transport: Sendable,
  thid: string,
  activity: { id: string; name?: string; command?: string; output?: string },
): void {
  sendStreamControl(transport, {
    t: 'tool',
    thid,
    id: activity.id,
    ...(activity.name ? { name: activity.name } : {}),
    ...(activity.command ? { command: activity.command } : {}),
    ...(activity.output !== undefined ? { output: activity.output } : {}),
  });
}

/** Emit an out-of-band advisory banner (e.g. a locked/new-controller notice). */
export function sendNotice(transport: Sendable, notice: Ac2Notice): void {
  sendStreamControl(transport, {
    t: 'notice',
    code: notice.code,
    level: notice.level ?? 'warning',
    ...(notice.title ? { title: notice.title } : {}),
    text: notice.text,
  });
}
