export { handleMessage, defaultMessageHandlers } from './handlers.js';
export type { MessageHandler, MessageHandlerMap, MessageHandlers } from './handlers.js';

export {
  createKeyRequest,
  createKeyResponse,
  createSigningRequest,
  createSigningResponse,
  createSigningRejected,
  buildSigningResponse,
  buildSigningRejected,
  buildKeyResponse,
  generateMessageId,
} from './messages.js';

export { Ac2Client } from '../client.js';
export type { Ac2ClientOptions } from '../client.js';

// High-level protocol types live in `schema/types.ts` (next to the body /
// message types they reference). Re-exported here for ergonomic access
// alongside the client + builders.
export type {
  SigningOutcome,
  SigningReply,
  SigningResponseReply,
  SigningRejectedReply,
  SigningResponder,
  KeyResponder,
  BuildSigningRequestArgs,
  BuildKeyRequestArgs,
  BuildSigningResponseArgs,
  BuildSigningRejectedArgs,
  BuildKeyResponseArgs,
} from '../schema/types.js';
