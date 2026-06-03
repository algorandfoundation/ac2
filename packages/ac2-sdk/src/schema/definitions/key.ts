/** Body schema for ac2/KeyRequest */
export const keyRequestBodySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: true,
} as const;

/** Body schema for ac2/KeyResponse */
export const keyResponseBodySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: true,
} as const;
