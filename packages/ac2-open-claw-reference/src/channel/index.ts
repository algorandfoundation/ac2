/** Channel domain: the `ac2` channel object, streaming, and conversation/session-key routing. */

export {
  buildChannelObject,
  AC2_MEDIA_SOURCE_PARAMS,
  type Ac2MediaSourceParams,
} from './channel-object.js';
export {
  getActiveConversation,
  resolveAc2SessionConversation,
  resolveAc2OutboundSessionRoute,
  buildAc2SessionKey,
  DEFAULT_THID,
  type Ac2SessionConversation,
  type Ac2OutboundSessionRoute,
} from './conversation.js';
export {
  sendStreamControl,
  sendPreview,
  sendFinalize,
  sendDiscard,
  sendNotice,
  AC2_STREAM_CONTROL_PREFIX,
  type Ac2LivePhase,
  type Ac2Notice,
  type Ac2NoticeLevel,
  type Sendable,
} from './stream.js';
