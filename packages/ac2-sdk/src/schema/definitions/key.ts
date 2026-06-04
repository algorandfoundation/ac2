import type { JSONSchemaType } from 'ajv';

import type { KeyRequestBody, KeyResponseBody } from '../types.js';
import { DRAFT_07_SCHEMA_URI } from './constants.js';

/** Body schema for ac2/KeyRequest */
export const keyRequestBodySchema: JSONSchemaType<KeyRequestBody> = {
  $schema: DRAFT_07_SCHEMA_URI,
  type: 'object',
  properties: {
    key_type: {
      type: 'string',
      enum: ['ed25519', 'secp256k1'],
    },
    derivation_path: {
      type: 'string',
      nullable: true,
    },
    purpose: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'encrypt',
          'decrypt',
          'sign',
          'verify',
          'deriveKey',
          'deriveBits',
          'wrapKey',
          'unwrapKey',
        ],
      },
      minItems: 1,
    },
    for_operation: {
      type: 'string',
    },
  },
  required: ['key_type', 'purpose', 'for_operation'],
  additionalProperties: false,
};

/** Body schema for ac2/KeyResponse */
export const keyResponseBodySchema: JSONSchemaType<KeyResponseBody> = {
  $schema: DRAFT_07_SCHEMA_URI,
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['approved', 'rejected'],
    },
    key_type: {
      type: 'string',
      enum: ['ed25519', 'secp256k1'],
    },
    material: {
      type: 'string',
      minLength: 1,
    },
    public_key: {
      type: 'string',
      minLength: 1,
    },
    derivation_path: {
      type: 'string',
      nullable: true,
    },
    reason: {
      type: 'string',
      nullable: true,
    },
  },
  required: ['status', 'key_type', 'material', 'public_key'],
  additionalProperties: false,
};
