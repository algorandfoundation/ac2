/** Body schema for ac2/SessionEstablish */
export const sessionEstablishBodySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["protocol_version"],
  properties: {
    protocol_version: { type: "string", pattern: "^\\d+\\.\\d+" },
    agent_did: { type: "string", pattern: "^did:" },
    capabilities: {
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: false,
} as const;

/** Body schema for ac2/SessionClose */
export const sessionCloseBodySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    reason: { type: "string" },
  },
  additionalProperties: false,
} as const;
