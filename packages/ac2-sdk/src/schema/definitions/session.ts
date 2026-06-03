/** Body schema for ac2/SessionEstablish */
export const sessionEstablishBodySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: true,
} as const;

/** Body schema for ac2/SessionClose */
export const sessionCloseBodySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: true,
} as const;
