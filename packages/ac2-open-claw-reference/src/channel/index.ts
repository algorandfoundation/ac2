/** Channel domain: the `ac2` channel object, streaming, conversations, routing. */

export {
  buildChannelObject,
  AC2_MEDIA_SOURCE_PARAMS,
  type Ac2MediaSourceParams,
} from './channel-object.js';
export {
  setActiveConversation,
  clearActiveConversation,
  getActiveConversation,
  resolveAc2SessionConversation,
  replayConversationList,
  replayConversationHistory,
  parseInboundChat,
  resolveAc2OutboundSessionRoute,
  DEFAULT_THID,
  type Ac2SessionConversation,
  type Ac2OutboundSessionRoute,
} from './conversation.js';
export { routeInboundToAgent, warmUpAgent } from './routing.js';
export {
  registerSubagentHooks,
  handleSubagentSpawned,
  handleSubagentEnded,
  resetSubagentHooksRegistration,
} from './subagent-hooks.js';
export {
  deriveTaskThid,
  isTaskThid,
  registerTask,
  attachSpawnResult,
  taskDisplayTitle,
  getTaskByThid,
  findTaskByRun,
  findPendingTaskForParent,
  markTaskResult,
  listTasks,
  resetTasks,
  TASK_THREAD_PREFIX,
  type Ac2Task,
  type Ac2TaskStatus,
} from './tasks.js';
export {
  sendStreamControl,
  sendPreview,
  sendFinalize,
  sendDiscard,
  sendToolActivity,
  sendNotice,
  AC2_STREAM_CONTROL_PREFIX,
  type Ac2LivePhase,
  type Ac2Notice,
  type Ac2NoticeLevel,
  type Sendable,
} from './stream.js';
