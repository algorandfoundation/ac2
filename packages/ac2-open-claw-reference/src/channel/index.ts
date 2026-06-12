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
  sendStreamControl,
  sendPreview,
  sendFinalize,
  sendDiscard,
  sendToolActivity,
  AC2_STREAM_CONTROL_PREFIX,
  type Ac2LivePhase,
  type Sendable,
} from './stream.js';
