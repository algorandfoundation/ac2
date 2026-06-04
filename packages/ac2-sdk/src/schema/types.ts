// ─── DIDComm v2 Base ─────────────────────────────────────────────────────────

/** DIDComm Attachment data object */
export interface AC2AttachmentData {
  json?: unknown;
  base64?: string;
  links?: string[];
}

/** Schema-friendly attachment data shape used by JSONSchemaType. */
export interface AC2AttachmentDataSchema {
  [key: string]: unknown;
}

/** DIDComm v2 Attachment */
export interface AC2Attachment {
  id: string;
  media_type?: string;
  description?: string;
  data: AC2AttachmentData;
}

/** Schema-friendly attachment shape used by JSONSchemaType. */
export interface AC2AttachmentSchema extends Omit<AC2Attachment, 'data'> {
  data: AC2AttachmentDataSchema;
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

/** Schema-friendly base envelope used by JSONSchemaType. */
export interface AC2BaseMessageSchema extends Omit<AC2BaseMessage, 'body' | 'attachments'> {
  body: Record<string, unknown>;
  attachments?: AC2AttachmentSchema[];
}

// ─── Message Type Constants ───────────────────────────────────────────────────

export const AC2MessageTypes = {
  SIGNING_REQUEST: 'ac2/SigningRequest',
  SIGNING_RESPONSE: 'ac2/SigningResponse',
  SIGNING_REJECTED: 'ac2/SigningRejected',
  KEY_REQUEST: 'ac2/KeyRequest',
  KEY_RESPONSE: 'ac2/KeyResponse',
} as const;

export type AC2MessageType = (typeof AC2MessageTypes)[keyof typeof AC2MessageTypes];

// ─── Body Types ───────────────────────────────────────────────────────────────

/** Explicit cryptographic-operation selector for ac2/SigningRequest. */
export type SigningHint =
  | 'raw-ed25519'
  | 'raw-secp256k1'
  | 'message-algorand'
  | 'message-evm'
  | 'message-solana'
  | 'typed-data-evm'
  | 'transaction-algorand'
  | 'transaction-evm'
  | 'transaction-solana';

/** Body for ac2/SigningRequest (agent → controller) */
export interface SigningRequestBody {
  /** Human-readable description shown to the user before they approve */
  description: string;
  /** Encoding of the `payload` field — MUST be `"base64"` */
  encoding: 'base64';
  /** The data to be signed, encoded per `encoding` */
  payload: string;
  /** Optional schema identifier for the payload (e.g. x402 payment schema URI) */
  schema?: string;
  /** Which key the signer SHOULD use (default: `"account"`) */
  key_type?: 'account' | 'identity';
  /** UX hint for how the wallet SHOULD preview `payload` to the user */
  display_hint?: 'text' | 'json' | 'hex';
  /** Explicit cryptographic-operation selector; when absent the signer performs raw Ed25519 */
  sig_hint?: SigningHint;
}

/** Body for ac2/SigningResponse (controller → agent) */
export interface SigningResponseBody {
  /*  Ed25519 signature */
  signature: string;
  /* 32-byte Ed25519 public key (base64 encoded) */
  public_key: string;
  /* Algorand Address (optional) */
  address?: string;
  /* Which key actually signed */
  key_type?: 'account' | 'identity';
}

/** Body for ac2/SigningRejected when the user rejects the signing request. */
export interface SigningRejectedBody {
  reason: string;
}

/** Body for ac2/KeyRequest (agent → controller) */
export interface KeyRequestBody {
  key_type: 'ed25519' | 'secp256k1' | 'falcon-512';
  purpose: string;
  for_operation: string;
}

/** Body for ac2/KeyResponse (controller → agent) */
export interface KeyResponseBody {
  [key: string]: unknown;
}

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

export type AC2Message =
  | AC2SigningRequest
  | AC2SigningResponse
  | AC2SigningRejected
  | AC2KeyRequest
  | AC2KeyResponse;

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
