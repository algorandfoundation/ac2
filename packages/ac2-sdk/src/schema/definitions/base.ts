import type { JSONSchemaType } from 'ajv';

import type { AC2AttachmentSchema, AC2BaseMessageSchema } from '../types.js';
import { DRAFT_07_SCHEMA_URI } from './constants.js';

const attachmentSchema: JSONSchemaType<AC2AttachmentSchema> = {
  type: 'object',
  required: ['id', 'data'],
  properties: {
    id: { type: 'string' },
    media_type: { type: 'string', nullable: true },
    description: { type: 'string', nullable: true },
    data: { type: 'object', additionalProperties: true },
  },
  additionalProperties: true,
};

/**
 * JSON Schema (Draft-07) for the AC2 / DIDComm v2 base message envelope.
 *
 * All AC2 messages MUST conform to this structure. The `body` content
 * is validated separately per message type (see validator.ts).
 */
export const baseMessageSchema: JSONSchemaType<AC2BaseMessageSchema> = {
  $schema: DRAFT_07_SCHEMA_URI,
  type: 'object',
  required: ['id', 'type', 'from', 'to', 'created_time', 'body'],
  properties: {
    '@context': {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
    },
    id: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1 },
    from: { type: 'string', pattern: '^did:' },
    to: {
      type: 'array',
      items: { type: 'string', pattern: '^did:' },
      minItems: 1,
    },
    created_time: { type: 'number', minimum: 0 },
    expires_time: { type: 'number', minimum: 0, nullable: true },
    thid: { type: 'string', nullable: true },
    pthid: { type: 'string', nullable: true },
    body: { type: 'object', additionalProperties: true },
    attachments: {
      type: 'array',
      items: attachmentSchema,
      nullable: true,
    },
  },
  additionalProperties: true,
};
