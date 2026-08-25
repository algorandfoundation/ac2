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

/** Key purpose/usage constraints for ac2/KeyRequest. */
export type KeyPurpose =
  | 'encrypt'
  | 'decrypt'
  | 'sign'
  | 'verify'
  | 'deriveKey'
  | 'deriveBits'
  | 'wrapKey'
  | 'unwrapKey';

/** Body for ac2/KeyRequest (agent → controller) */
export interface KeyRequestBody {
  key_type: 'ed25519' | 'secp256k1';
  derivation_path?: string;
  /** Array of permitted key purposes/usages */
  purpose: KeyPurpose[];
  for_operation: string;
}

/** Body for ac2/KeyResponse (controller → agent)
 *
 * NOTE: Future versions may split this into separate KeyResponse and KeyRejected
 * messages, similar to the SigningResponse/SigningRejected flow. For now, a single
 * message type handles both approval and rejection via the `status` field.
 */
export interface KeyResponseBody {
  /** Response status: approved or rejected */
  status: 'approved' | 'rejected';
  /** The key type that was generated */
  key_type: 'ed25519' | 'secp256k1';
  /** Key material (base64 encoded) */
  material: string;
  /** Public key (base64 encoded) */
  public_key: string;
  /** Derivation path used (if applicable) */
  derivation_path?: string;
  /** Rejection reason (if status is "rejected") */
  reason?: string;
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

// ─── High-level Protocol Types ────────────────────────────────────────────────
//
// Shared shapes consumed by `Ac2Client` and the response/rejected builders.
// They live here (next to the body/message types they reference) so the
// client module can focus on dispatch and lifecycle, and the builders module
// can focus on envelope construction.

/**
 * Discriminated outcome of `Ac2Client.requestSignature`.
 *
 * - `{ kind: 'response', ... }` — controller approved and returned a signature.
 * - `{ kind: 'rejected', ... }` — controller declined; `message.body.reason`
 *   carries the user-supplied explanation.
 */
export type SigningOutcome =
  | { kind: 'response'; message: AC2SigningResponse }
  | { kind: 'rejected'; message: AC2SigningRejected };

/**
 * Approval reply returned by a {@link SigningResponder}. Carries the
 * signature body the SDK will wrap in an `ac2/SigningResponse`.
 */
export interface SigningResponseReply {
  kind: 'approve';
  body: SigningResponseBody;
}

/**
 * Rejection reply returned by a {@link SigningResponder}. The
 * `reason` string is surfaced to the requesting agent verbatim.
 */
export interface SigningRejectedReply {
  kind: 'reject';
  reason: string;
}

/** Either reply shape returned by a {@link SigningResponder}. */
export type SigningReply = SigningResponseReply | SigningRejectedReply;

/**
 * Function shape registered via `Ac2Client.onSigningRequest`. Inspects
 * an inbound signing request and returns either an approval (with the
 * signed payload) or a rejection (with a human-readable reason).
 */
export type SigningResponder = (request: AC2SigningRequest) => SigningReply | Promise<SigningReply>;

/**
 * Function shape registered via `Ac2Client.onKeyRequest`. Inspects an
 * inbound key request and returns the `ac2/KeyResponse` body — the
 * `status` field encodes the approve / reject distinction per the
 * spec's single-message KeyResponse shape.
 */
export type KeyResponder = (request: AC2KeyRequest) => KeyResponseBody | Promise<KeyResponseBody>;

/**
 * Arguments for `Ac2Client.requestSignature`.
 *
 * Envelope fields not supplied (`id`, `created_time`) are filled in
 * automatically: `id` is generated (UUIDv4 when `crypto.randomUUID` is
 * available), `created_time` defaults to the current Unix time in
 * seconds.
 */
export interface BuildSigningRequestArgs {
  /** DID of the agent issuing the request. */
  from: string;
  /** DID(s) of the controller(s) that should receive the request. */
  to: string | readonly string[];
  /** Typed `ac2/SigningRequest` body. */
  body: SigningRequestBody;
  /** Override the generated message id. */
  id?: string;
  /** Override the default `created_time` (Unix seconds). */
  created_time?: number;
  /** Optional `expires_time` (Unix seconds). */
  expires_time?: number;
}

/**
 * Arguments for `Ac2Client.requestKey`. Envelope defaults match
 * {@link BuildSigningRequestArgs}.
 */
export interface BuildKeyRequestArgs {
  /** DID of the agent issuing the request. */
  from: string;
  /** DID(s) of the controller(s) that should receive the request. */
  to: string | readonly string[];
  /** Typed `ac2/KeyRequest` body. */
  body: KeyRequestBody;
  /** Override the generated message id. */
  id?: string;
  /** Override the default `created_time` (Unix seconds). */
  created_time?: number;
  /** Optional `expires_time` (Unix seconds). */
  expires_time?: number;
}

/** Arguments for `buildSigningResponse`. */
export interface BuildSigningResponseArgs {
  /** The request being answered — used to thread `thid` and address `to`. */
  request: Pick<AC2SigningRequest, 'id' | 'from' | 'to'>;
  /** Controller DID (the signer); defaults to `request.to[0]`. */
  from?: string;
  /** Typed `ac2/SigningResponse` body (signature material). */
  body: SigningResponseBody;
  /** Override the generated message id. */
  id?: string;
  /** Override the default `created_time` (Unix seconds). */
  created_time?: number;
  /** Optional `expires_time` (Unix seconds). */
  expires_time?: number;
}

/** Arguments for `buildSigningRejected`. */
export interface BuildSigningRejectedArgs {
  /** The request being declined — used to thread `thid` and address `to`. */
  request: Pick<AC2SigningRequest, 'id' | 'from' | 'to'>;
  /** Controller DID (the signer); defaults to `request.to[0]`. */
  from?: string;
  /** Human-readable rejection reason; surfaced to the requesting agent. */
  reason: string;
  /** Override the generated message id. */
  id?: string;
  /** Override the default `created_time` (Unix seconds). */
  created_time?: number;
  /** Optional `expires_time` (Unix seconds). */
  expires_time?: number;
}

/** Arguments for `buildKeyResponse`. */
export interface BuildKeyResponseArgs {
  /** The request being answered — used to thread `thid` and address `to`. */
  request: Pick<AC2KeyRequest, 'id' | 'from' | 'to'>;
  /** Controller DID (the keystore holder); defaults to `request.to[0]`. */
  from?: string;
  /** Typed `ac2/KeyResponse` body (status + key material, or rejection). */
  body: KeyResponseBody;
  /** Override the generated message id. */
  id?: string;
  /** Override the default `created_time` (Unix seconds). */
  created_time?: number;
  /** Optional `expires_time` (Unix seconds). */
  expires_time?: number;
}
