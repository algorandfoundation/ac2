/** Body schema for ac2/StreamRequest */
export const streamRequestBodySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: true,
} as const;

/** Body schema for ac2/StreamChunk */
export const streamChunkBodySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: true,
} as const;

/** Body schema for ac2/StreamEnd */
export const streamEndBodySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: true,
} as const;
