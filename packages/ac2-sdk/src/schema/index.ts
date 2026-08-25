export type {
  AC2Attachment,
  AC2AttachmentData,
  AC2BaseMessage,
  AC2KeyRequest,
  AC2KeyResponse,
  AC2Message,
  AC2MessageType,
  AC2SigningRejected,
  AC2SigningRequest,
  AC2SigningResponse,
  DecodeResult,
  KeyRequestBody,
  KeyResponseBody,
  KeyPurpose,
  SigningHint,
  SigningRequestBody,
  SigningResponseBody,
  ValidationResult,
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
} from './types.js';

export { AC2MessageTypes } from './types.js';

export {
  decode,
  isKeyRequest,
  isKeyResponse,
  isAc2Message,
  isSigningRequest,
  isSigningResponse,
  isSigningRejected,
} from './decoder.js';

export { validate, validateBody, validateMessage } from './validator.js';

export { baseMessageSchema } from './definitions/base.js';
export { keyRequestBodySchema, keyResponseBodySchema } from './definitions/key.js';

export {
  signingRequestBodySchema,
  signingResponseBodySchema,
  signingRejectedBodySchema,
} from './definitions/signing.js';
