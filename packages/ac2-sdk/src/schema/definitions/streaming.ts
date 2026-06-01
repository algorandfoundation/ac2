const CONTENT_TYPES = ["text", "audio"] as const;

const usageSchema = {
  type: "object",
  properties: {
    input_tokens: { type: "number", minimum: 0 },
    output_tokens: { type: "number", minimum: 0 },
    total_tokens: { type: "number", minimum: 0 },
  },
  additionalProperties: false,
} as const;

/** Body schema for ac2/StreamRequest */
export const streamRequestBodySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["stream_id", "content", "content_type"],
  properties: {
    stream_id: { type: "string", minLength: 1 },
    content: { type: "string", minLength: 1 },
    content_type: { type: "string", enum: CONTENT_TYPES },
  },
  additionalProperties: false,
} as const;

/** Body schema for ac2/StreamChunk */
export const streamChunkBodySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["stream_id", "sequence", "content", "content_type"],
  properties: {
    stream_id: { type: "string", minLength: 1 },
    sequence: { type: "number", minimum: 0 },
    content: { type: "string" },
    content_type: { type: "string", enum: CONTENT_TYPES },
    is_last: { type: "boolean" },
    usage: usageSchema,
  },
  additionalProperties: false,
} as const;

/** Body schema for ac2/StreamEnd */
export const streamEndBodySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["stream_id"],
  properties: {
    stream_id: { type: "string", minLength: 1 },
    usage: usageSchema,
  },
  additionalProperties: false,
} as const;
