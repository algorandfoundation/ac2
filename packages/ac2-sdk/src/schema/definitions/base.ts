/**
 * JSON Schema (Draft-07) for the AC2 / DIDComm v2 base message envelope.
 *
 * All AC2 messages MUST conform to this structure. The `body` content
 * is validated separately per message type (see validator.ts).
 */
export const baseMessageSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['id', 'type', 'from', 'to', 'created_time', 'body'],
  properties: {
    '@context': {
      type: 'array',
      items: { type: 'string' },
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
    expires_time: { type: 'number', minimum: 0 },
    thid: { type: 'string' },
    pthid: { type: 'string' },
    body: { type: 'object' },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'data'],
        properties: {
          id: { type: 'string' },
          media_type: { type: 'string' },
          description: { type: 'string' },
          data: { type: 'object' },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
} as const;
