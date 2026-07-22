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
  buildAc2SessionKey,
  DEFAULT_THID,
  type Ac2SessionConversation,
  type Ac2OutboundSessionRoute,
} from './conversation.js';
export {
  routeInboundToAgent,
  warmUpAgent,
  classifyAgentError,
  type Ac2AgentError,
} from './routing.js';
export { emitTaskCardUpdate } from './task-card.js';
export {
  registerSubagentHooks,
  handleSubagentSpawned,
  handleSubagentEnded,
  resetSubagentHooksRegistration,
  watchTaskCompletion,
  resetTaskWatchers,
  subagentPolling,
} from './subagent-hooks.js';
export {
  readChildResultText,
  readChildSessionStatus,
  discoverChildSessionKey,
  describeSubagentCandidates,
  type ChildSessionStatus,
} from './subagent-result.js';
export {
  deriveTaskThid,
  isTaskThid,
  registerTask,
  attachSpawnResult,
  taskDisplayTitle,
  taskCardId,
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
  sendTaskCard,
  sendNotice,
  AC2_STREAM_CONTROL_PREFIX,
  type Ac2LivePhase,
  type Ac2TaskCardStatus,
  type Ac2Notice,
  type Ac2NoticeLevel,
  type Sendable,
} from './stream.js';
