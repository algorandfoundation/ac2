import type { JSONSchemaType } from 'ajv';

import type { SigningRequestBody, SigningResponseBody } from '../types.js';
import { DRAFT_07_SCHEMA_URI } from './constants.js';
const SIGNING_ENCODINGS = ['base64', 'hex', 'utf8', 'cbor'] as const;

/** Body schema for ac2/SigningRequest */
export const signingRequestBodySchema: JSONSchemaType<SigningRequestBody> = {
  $schema: DRAFT_07_SCHEMA_URI,
  type: 'object',
  required: ['description', 'encoding', 'payload'],
  properties: {
    description: { type: 'string', minLength: 1 },
    encoding: { type: 'string', enum: SIGNING_ENCODINGS },
    payload: { type: 'string', minLength: 1 },
    schema: { type: 'string', nullable: true },
  },
  additionalProperties: false,
};

/** Body schema for ac2/SigningResponse */
export const signingResponseBodySchema: JSONSchemaType<SigningResponseBody> = {
  $schema: DRAFT_07_SCHEMA_URI,
  type: 'object',
  required: ['status', 'signature', 'timestamp'],
  properties: {
    status: { type: 'string', enum: ['approved', 'rejected'] },
    signature: { type: 'string', minLength: 1 },
    timestamp: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};
