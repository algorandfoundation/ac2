/** Body schema for ac2/KeyRequest */
export const keyRequestBodySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    key_type: {
      type: 'string',
      enum: ['ed25519', 'secp256k1', 'falcon-512'],
    },
    purpose: {
      type: 'string',
    },
    for_operation: {
      type: 'string',
    },
  },
  required: ['key_type', 'purpose', 'for_operation'],
  additionalProperties: false,
} as const;

/** Body schema for ac2/KeyResponse */
export const keyResponseBodySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: true,
} as const;
