const SIGNING_ENCODINGS = ['base64', 'hex', 'utf8', 'cbor'] as const;

/** Body schema for ac2/SigningRequest */
export const signingRequestBodySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['description', 'encoding', 'payload'],
  properties: {
    description: { type: 'string', minLength: 1 },
    encoding: { type: 'string', enum: SIGNING_ENCODINGS },
    payload: { type: 'string', minLength: 1 },
    schema: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/** Body schema for ac2/SigningResponse */
export const signingResponseBodySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['status', 'signature', 'timestamp'],
  properties: {
    status: { type: 'string', enum: ['approved', 'rejected'] },
    signature: { type: 'string', minLength: 1 },
    timestamp: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;
