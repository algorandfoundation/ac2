const KEY_TYPES = ["ed25519", "secp256k1", "falcon-512"] as const;
const KEY_ENCODINGS = ["base64", "base64url", "hex"] as const;

/** Body schema for ac2/KeyRequest */
export const keyRequestBodySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["key_type", "purpose", "for_operation"],
  properties: {
    key_type: { type: "string", enum: KEY_TYPES },
    purpose: { type: "string", minLength: 1 },
    for_operation: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

/** Body schema for ac2/KeyResponse */
export const keyResponseBodySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["key_type", "public_key", "encoding"],
  properties: {
    key_type: { type: "string", enum: KEY_TYPES },
    public_key: { type: "string", minLength: 1 },
    encoding: { type: "string", enum: KEY_ENCODINGS },
  },
  additionalProperties: false,
} as const;
