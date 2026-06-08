import type { JSONSchemaType } from 'ajv';

import type { SigningRejectedBody, SigningRequestBody, SigningResponseBody } from '../types.js';
import { DRAFT_07_SCHEMA_URI } from './constants.js';

/** Body schema for ac2/SigningRequest */
export const signingRequestBodySchema: JSONSchemaType<SigningRequestBody> = {
  $schema: DRAFT_07_SCHEMA_URI,
  type: 'object',
  required: ['description', 'encoding', 'payload'],
  properties: {
    description: { type: 'string', minLength: 1 },
    encoding: { type: 'string', const: 'base64' },
    payload: { type: 'string', minLength: 1 },
    schema: { type: 'string', nullable: true },
    key_type: { type: 'string', enum: ['account', 'identity'], nullable: true },
    display_hint: { type: 'string', enum: ['text', 'json', 'hex'], nullable: true },
    sig_hint: {
      type: 'string',
      enum: [
        'raw-ed25519',
        'raw-secp256k1',
        'message-algorand',
        'message-evm',
        'message-solana',
        'typed-data-evm',
        'transaction-algorand',
        'transaction-evm',
        'transaction-solana',
      ],
      nullable: true,
    },
  },
  additionalProperties: false,
};

/** Body schema for ac2/SigningResponse */
export const signingResponseBodySchema: JSONSchemaType<SigningResponseBody> = {
  $schema: DRAFT_07_SCHEMA_URI,
  type: 'object',
  required: ['signature', 'public_key'],
  properties: {
    signature: { type: 'string', minLength: 1 },
    public_key: { type: 'string', minLength: 1 },
    address: { type: 'string', nullable: true, minLength: 58, maxLength: 58 },
    key_type: { type: 'string', enum: ['account', 'identity'], nullable: true },
  },
  additionalProperties: false,
};

/** Body schema for ac2/SigningRejected */
export const signingRejectedBodySchema: JSONSchemaType<SigningRejectedBody> = {
  $schema: DRAFT_07_SCHEMA_URI,
  type: 'object',
  required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};
