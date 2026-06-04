export type {
  AC2Attachment,
  AC2AttachmentData,
  AC2BaseMessage,
  AC2KeyRequest,
  AC2KeyResponse,
  AC2Message,
  AC2MessageType,
  AC2SigningRequest,
  AC2SigningResponse,
  DecodeResult,
  KeyRequestBody,
  KeyResponseBody,
  SigningRequestBody,
  SigningResponseBody,
  ValidationResult,
} from './types.js';

export { AC2MessageTypes } from './types.js';

export {
  decode,
  isKeyRequest,
  isKeyResponse,
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
