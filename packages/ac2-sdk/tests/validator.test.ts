/// <reference types="vitest/globals" />

import { AC2MessageTypes } from "../src/schema/types";
import { validate, validateBody } from "../src/schema/validator";

const NOW = Math.floor(Date.now() / 1000);

const validSigningRequest = {
  id: "test-001",
  type: "ac2/SigningRequest",
  from: "did:key:alice",
  to: ["did:key:bob"],
  created_time: NOW,
  body: {
    description: "Sign this payload",
    encoding: "base64",
    payload: "dGVzdA==",
    operation: "algorand-txn",
  },
};

// ─── Base envelope ────────────────────────────────────────────────────────────

describe("validate() — base envelope", () => {
  it("accepts a fully valid SigningRequest", () => {
    const r = validate(validSigningRequest);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("rejects a non-object payload", () => {
    const r = validate("not-an-object");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/non-null object/);
  });

  it("rejects null", () => {
    const r = validate(null);
    expect(r.valid).toBe(false);
  });

  it("rejects missing id", () => {
    const { id: _, ...noId } = validSigningRequest;
    const r = validate(noId);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("rejects missing from", () => {
    const { from: _, ...noFrom } = validSigningRequest;
    const r = validate(noFrom);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("from"))).toBe(true);
  });

  it("rejects from without did: prefix", () => {
    const r = validate({ ...validSigningRequest, from: "alice" });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("from"))).toBe(true);
  });

  it("rejects to[] with non-DID entry", () => {
    const r = validate({ ...validSigningRequest, to: ["bob"] });
    expect(r.valid).toBe(false);
  });

  it("rejects empty to[]", () => {
    const r = validate({ ...validSigningRequest, to: [] });
    expect(r.valid).toBe(false);
  });

  it("warns on expired message", () => {
    const r = validate({ ...validSigningRequest, expires_time: NOW - 60 });
    expect(r.warnings.some((w) => w.includes("expired"))).toBe(true);
  });

  it("does NOT warn when expires_time is in the future", () => {
    const r = validate({ ...validSigningRequest, expires_time: NOW + 3600 });
    expect(r.warnings.some((w) => w.includes("expired"))).toBe(false);
  });

  it("warns on unknown message type", () => {
    const r = validate({ ...validSigningRequest, type: "custom/Foo" });
    expect(r.warnings.some((w) => w.includes("Unknown message type"))).toBe(true);
  });

  it("sets messageType in the result", () => {
    const r = validate(validSigningRequest);
    expect(r.messageType).toBe("ac2/SigningRequest");
  });
});

// ─── SigningRequest body ──────────────────────────────────────────────────────

describe("validate() — SigningRequest body", () => {
  it("accepts all valid encodings", () => {
    for (const enc of ["base64", "hex", "utf8", "cbor"]) {
      const r = validate({
        ...validSigningRequest,
        body: { ...validSigningRequest.body, encoding: enc },
      });
      expect(r.valid).toBe(true);
    }
  });

  it("rejects invalid encoding", () => {
    const r = validate({
      ...validSigningRequest,
      body: { ...validSigningRequest.body, encoding: "binary" },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("encoding"))).toBe(true);
  });

  it("rejects empty description", () => {
    const r = validate({
      ...validSigningRequest,
      body: { ...validSigningRequest.body, description: "" },
    });
    expect(r.valid).toBe(false);
  });

  it("rejects body missing all required fields", () => {
    const r = validate({ ...validSigningRequest, body: {} });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("accepts optional schema and context", () => {
    const r = validate({
      ...validSigningRequest,
      body: { ...validSigningRequest.body, schema: "https://x402.org/v1", context: "API fee" },
    });
    expect(r.valid).toBe(true);
  });
});

// ─── SigningResponse ──────────────────────────────────────────────────────────

describe("validate() — SigningResponse", () => {
  const base = {
    id: "test-002",
    type: "ac2/SigningResponse",
    from: "did:key:bob",
    to: ["did:key:alice"],
    created_time: NOW,
    thid: "test-001",
    body: {
      signature: "c2lnbmF0dXJl",
      timestamp: new Date().toISOString(),
    },
  };

  it("accepts a valid SigningResponse", () => {
    expect(validate(base).valid).toBe(true);
  });

  it("accepts response without optional timestamp", () => {
    const r = validate({ ...base, body: { signature: "c2lnbmF0dXJl" } });
    expect(r.valid).toBe(true);
  });

  it("rejects missing signature", () => {
    const r = validate({ ...base, body: { timestamp: new Date().toISOString() } });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("signature"))).toBe(true);
  });
});

// ─── SigningRejected ──────────────────────────────────────────────────────────

describe("validate() — SigningRejected", () => {
  const base = {
    id: "test-003",
    type: "ac2/SigningRejected",
    from: "did:key:bob",
    to: ["did:key:alice"],
    created_time: NOW,
    thid: "test-001",
    body: { reason: "Rejected by user" },
  };

  it("accepts a valid SigningRejected", () => {
    expect(validate(base).valid).toBe(true);
  });

  it("rejects empty reason", () => {
    const r = validate({ ...base, body: { reason: "" } });
    expect(r.valid).toBe(false);
  });
});

// ─── KeyRequest ───────────────────────────────────────────────────────────────

describe("validate() — KeyRequest", () => {
  const base = {
    id: "test-004",
    type: "ac2/KeyRequest",
    from: "did:key:agent",
    to: ["did:key:user"],
    created_time: NOW,
    body: {
      key_type: "ed25519",
      purpose: "Algorand identity",
      for_operation: "algorand-txn",
    },
  };

  it("accepts ed25519", () => expect(validate(base).valid).toBe(true));
  it("accepts secp256k1", () => {
    expect(validate({ ...base, body: { ...base.body, key_type: "secp256k1" } }).valid).toBe(true);
  });
  it("accepts falcon-512", () => {
    expect(validate({ ...base, body: { ...base.body, key_type: "falcon-512" } }).valid).toBe(true);
  });
  it("rejects unsupported key type", () => {
    const r = validate({ ...base, body: { ...base.body, key_type: "rsa-2048" } });
    expect(r.valid).toBe(false);
  });
});

// ─── SessionEstablish ─────────────────────────────────────────────────────────

describe("validate() — SessionEstablish", () => {
  const base = {
    id: "test-005",
    type: "ac2/SessionEstablish",
    from: "did:key:agent",
    to: ["did:key:user"],
    created_time: NOW,
    body: { protocol_version: "1.0" },
  };

  it("accepts minimal SessionEstablish", () => expect(validate(base).valid).toBe(true));
  it("accepts with capabilities", () => {
    const r = validate({
      ...base,
      body: { ...base.body, capabilities: ["signing", "streaming"] },
    });
    expect(r.valid).toBe(true);
  });
  it("rejects invalid protocol_version format", () => {
    const r = validate({ ...base, body: { protocol_version: "v1" } });
    expect(r.valid).toBe(false);
  });
});

// ─── StreamChunk ──────────────────────────────────────────────────────────────

describe("validate() — StreamChunk", () => {
  const base = {
    id: "test-006",
    type: "ac2/StreamChunk",
    from: "did:key:agent",
    to: ["did:key:user"],
    created_time: NOW,
    body: {
      stream_id: "stream-1",
      sequence: 0,
      content: "Hello world",
      content_type: "text",
    },
  };

  it("accepts a valid StreamChunk", () => expect(validate(base).valid).toBe(true));
  it("accepts audio content_type", () => {
    const r = validate({ ...base, body: { ...base.body, content_type: "audio" } });
    expect(r.valid).toBe(true);
  });
  it("accepts optional is_last and usage", () => {
    const r = validate({
      ...base,
      body: { ...base.body, is_last: true, usage: { input_tokens: 5, output_tokens: 10 } },
    });
    expect(r.valid).toBe(true);
  });
  it("rejects invalid content_type", () => {
    const r = validate({ ...base, body: { ...base.body, content_type: "video" } });
    expect(r.valid).toBe(false);
  });
});

// ─── validateBody() ───────────────────────────────────────────────────────────

describe("validateBody()", () => {
  it("returns valid with warning for unknown type", () => {
    const r = validateBody("custom/Unknown", {});
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.includes("No body schema"))).toBe(true);
  });

  it("validates a correct SigningRequest body", () => {
    const r = validateBody(AC2MessageTypes.SIGNING_REQUEST, {
      description: "test",
      encoding: "base64",
      payload: "dGVzdA==",
      operation: "test-op",
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("rejects an invalid SigningRequest body", () => {
    const r = validateBody(AC2MessageTypes.SIGNING_REQUEST, { description: "only this" });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
