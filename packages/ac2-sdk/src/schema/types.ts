// ─── DIDComm v2 Base ─────────────────────────────────────────────────────────

/** DIDComm Attachment data object */
export interface AC2AttachmentData {
  json?: unknown;
  base64?: string;
  links?: string[];
}

/** DIDComm v2 Attachment */
export interface AC2Attachment {
  id: string;
  media_type?: string;
  description?: string;
  data: AC2AttachmentData;
}

/**
 * Base AC2 / DIDComm v2 plaintext message envelope.
 *
 * Messages should follow DIDComm v2.0 envelope semantics and use valid
 * DIDs for `from` / `to`.
 */
export interface AC2BaseMessage {
  '@context'?: string[];
  /** Unique message ID (UUID recommended) */
  id: string;
  /** Message type URI, e.g. "ac2/SigningRequest" */
  type: string;
  /** DID of the sender */
  from: string;
  /** DIDs of recipients */
  to: string[];
  /** Unix timestamp (seconds) */
  created_time: number;
  /** Unix timestamp for expiry (seconds) */
  expires_time?: number;
  /** Thread ID — links reply messages to the original request */
  thid?: string;
  /** Parent thread ID — for sub-threads (e.g. stream threads) */
  pthid?: string;
  body: object;
  attachments?: AC2Attachment[];
}

// ─── Message Type Constants ───────────────────────────────────────────────────

export const AC2MessageTypes = {
  SESSION_ESTABLISH: 'ac2/SessionEstablish',
  SESSION_CLOSE: 'ac2/SessionClose',
  SIGNING_REQUEST: 'ac2/SigningRequest',
  SIGNING_RESPONSE: 'ac2/SigningResponse',
  SIGNING_REJECTED: 'ac2/SigningRejected',
  KEY_REQUEST: 'ac2/KeyRequest',
  KEY_RESPONSE: 'ac2/KeyResponse',
  STREAM_REQUEST: 'ac2/StreamRequest',
  STREAM_CHUNK: 'ac2/StreamChunk',
  STREAM_END: 'ac2/StreamEnd',
} as const;

export type AC2MessageType = (typeof AC2MessageTypes)[keyof typeof AC2MessageTypes];

// ─── Body Types ───────────────────────────────────────────────────────────────

export type SigningEncoding = 'base64' | 'hex' | 'utf8' | 'cbor';
export type KeyType = 'ed25519' | 'secp256k1' | 'falcon-512';
export type KeyEncoding = 'base64' | 'base64url' | 'hex';

/** Body for ac2/SigningRequest (agent → controller) */
export interface SigningRequestBody {
  /** Human-readable description shown to the user before they approve */
  description: string;
  /** Encoding of the `payload` field */
  encoding: SigningEncoding;
  /** The data to be signed, encoded per `encoding` */
  payload: string;
  /** Optional schema identifier for the payload (e.g. x402 payment schema URI) */
  schema?: string;
}

/** Body for ac2/SigningResponse (controller → agent) */
export interface SigningResponseBody {
  /** The raw signature, base64-encoded */
  signature: string;
}

/** Body for ac2/SigningRejected (controller → agent) */
export interface SigningRejectedBody {
  /** Human-readable reason for rejection */
  reason: string;
}

/** Body for ac2/KeyRequest (agent → controller) */
export type KeyRequestBody = Record<string, unknown>;

/** Body for ac2/KeyResponse (controller → agent) */
export type KeyResponseBody = Record<string, unknown>;

/** Body for ac2/SessionEstablish */
export type SessionEstablishBody = Record<string, unknown>;

/** Body for ac2/SessionClose */
export type SessionCloseBody = Record<string, unknown>;

/** Body for ac2/StreamRequest (controller → agent) */
export type StreamRequestBody = Record<string, unknown>;

/** Token usage statistics embedded in stream chunks */
export interface StreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/** Body for ac2/StreamChunk (agent → controller) */
export type StreamChunkBody = Record<string, unknown>;

/** Body for ac2/StreamEnd (agent → controller) */
export type StreamEndBody = Record<string, unknown>;

// ─── Typed Messages ───────────────────────────────────────────────────────────
//
// Each typed message narrows `body` from the base `object` to its specific
// interface. TypeScript allows this because every body interface is assignable
// to `object`, so the extends constraint is satisfied.

export interface AC2SigningRequest extends AC2BaseMessage {
  type: 'ac2/SigningRequest';
  body: SigningRequestBody;
}

export interface AC2SigningResponse extends AC2BaseMessage {
  type: 'ac2/SigningResponse';
  body: SigningResponseBody;
}

export interface AC2SigningRejected extends AC2BaseMessage {
  type: 'ac2/SigningRejected';
  body: SigningRejectedBody;
}

export interface AC2KeyRequest extends AC2BaseMessage {
  type: 'ac2/KeyRequest';
  body: KeyRequestBody;
}

export interface AC2KeyResponse extends AC2BaseMessage {
  type: 'ac2/KeyResponse';
  body: KeyResponseBody;
}

export interface AC2SessionEstablish extends AC2BaseMessage {
  type: 'ac2/SessionEstablish';
  body: SessionEstablishBody;
}

export interface AC2SessionClose extends AC2BaseMessage {
  type: 'ac2/SessionClose';
  body: SessionCloseBody;
}

export interface AC2StreamRequest extends AC2BaseMessage {
  type: 'ac2/StreamRequest';
  body: StreamRequestBody;
}

export interface AC2StreamChunk extends AC2BaseMessage {
  type: 'ac2/StreamChunk';
  body: StreamChunkBody;
}

export interface AC2StreamEnd extends AC2BaseMessage {
  type: 'ac2/StreamEnd';
  body: StreamEndBody;
}

export type AC2Message =
  | AC2SigningRequest
  | AC2SigningResponse
  | AC2SigningRejected
  | AC2KeyRequest
  | AC2KeyResponse
  | AC2SessionEstablish
  | AC2SessionClose
  | AC2StreamRequest
  | AC2StreamChunk
  | AC2StreamEnd;

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** The `type` field from the message, if present */
  messageType?: string;
}

export interface DecodeResult<T extends AC2BaseMessage = AC2Message> {
  message: T;
  validation: ValidationResult;
}
