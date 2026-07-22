/**
 * Deliver a background-task ("`sessions_spawn`") card into a wallet thread.
 *
 * A task card is a self-contained sub-agent run: the spawning turn emits it as
 * `running` (in `routing.ts`) and, when the child finishes, the completion path
 * re-emits the SAME card id with a terminal `status` and the child's `result`
 * text inline — so the wallet renders one card that flips from running to
 * done/failed with the answer inside it, rather than a static "running…" card
 * plus a disconnected reply bubble.
 *
 * This helper is the *completion*-side emitter (the spawn side lives inline in
 * `routing.ts` where the turn already has a transport + requestId). It resolves
 * the active session's control-frame surface (the dedicated `ac2-stream`
 * channel when negotiated, else the main transport — see
 * `resolveControlSendable`), emits the `task` frame over it, and persists the
 * card to the thread's history so it survives a reconnect.
 */

import { sessionManager } from '../session/manager.js';
import { recordTaskActivity } from '../identity/state.js';
import { resolveControlSendable, sendTaskCard, type Ac2TaskCardStatus } from './stream.js';
import { taskCardId, taskDisplayTitle, type Ac2Task } from './tasks.js';

/**
 * Emit/refresh a task card for `task` into `thid` with `status` and (optionally)
 * the child's `result` text. Best-effort; never throws.
 */
export function emitTaskCardUpdate(params: {
  thid: string;
  task: Ac2Task;
  status: Ac2TaskCardStatus;
  result?: string;
}): void {
  const active = sessionManager.getActive();
  if (!active) return;

  const id = taskCardId(params.task.taskThid);
  const title = taskDisplayTitle(params.task);
  const prompt = params.task.task;
  const card = {
    id,
    title,
    status: params.status,
    ...(prompt && prompt.length > 0 ? { prompt } : {}),
    ...(params.result !== undefined ? { result: params.result } : {}),
  };

  // Re-emit the SAME card id so the wallet upserts the running card in place to
  // its terminal state. Send over the dedicated stream channel when present,
  // else over the main transport (the wallet parses STX control frames on
  // either, and the spawning turn rendered the initial `running` card the same
  // way). We must never downgrade to a raw `transport.send(result)` here: that
  // posts a disconnected reply bubble and leaves the task card stuck `running`.
  const control = resolveControlSendable(active);
  if (control) {
    sendTaskCard(control, params.thid, card);
  }

  if (active.requestId) {
    recordTaskActivity(active.requestId, params.thid, card);
  }
}
