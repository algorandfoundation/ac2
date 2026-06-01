/// <reference types="vitest/globals" />

import {
  decode,
  isKeyRequest,
  isKeyResponse,
  isSessionClose,
  isSessionEstablish,
  isSigningRejected,
  isSigningRequest,
  isSigningResponse,
  isStreamChunk,
  isStreamEnd,
  isStreamRequest,
} from "../src/schema/decoder";
import { handleMessage } from "../src/protocol/handlers";

const NOW = Math.floor(Date.now() / 1000);

const baseEnvelope = {
  id: "dec-001",
  from: "did:key:alice",
  to: ["did:key:bob"],
  created_time: NOW,
};

const signingRequestMsg = {
  ...baseEnvelope,
  type: "ac2/SigningRequest",
  body: {
    description: "Sign Algorand transaction",
    encoding: "base64",
    payload: "dGVzdA==",
    operation: "algorand-txn",
  },
};

// ─── decode() ─────────────────────────────────────────────────────────────────

describe("decode()", () => {
  it("decodes a valid JSON string", () => {
    const { message, validation } = decode(JSON.stringify(signingRequestMsg));
    expect(validation.valid).toBe(true);
    expect(message.type).toBe("ac2/SigningRequest");
  });

  it("decodes a plain object without cloning it", () => {
    const { message, validation } = decode(signingRequestMsg);
    expect(validation.valid).toBe(true);
    expect(message.id).toBe("dec-001");
  });

  it("returns invalid for malformed JSON", () => {
    const { validation } = decode("{bad json}");
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toMatch(/Invalid JSON/);
  });

  it("returns invalid for a structurally wrong object", () => {
    const { validation } = decode({ type: "ac2/SigningRequest" });
    expect(validation.valid).toBe(false);
  });

  it("sets messageType on the validation result", () => {
    const { validation } = decode(signingRequestMsg);
    expect(validation.messageType).toBe("ac2/SigningRequest");
  });
});

// ─── Type guards ──────────────────────────────────────────────────────────────

describe("type guards", () => {
  it("isSigningRequest: true for matching type", () => {
    const { message } = decode(signingRequestMsg);
    expect(isSigningRequest(message)).toBe(true);
  });

  it("isSigningRequest: false for other types", () => {
    const { message } = decode({
      ...baseEnvelope,
      type: "ac2/SigningResponse",
      body: { signature: "sig" },
    });
    expect(isSigningRequest(message)).toBe(false);
  });

  it("isSigningResponse", () => {
    const { message } = decode({
      ...baseEnvelope,
      type: "ac2/SigningResponse",
      body: { signature: "sig" },
    });
    expect(isSigningResponse(message)).toBe(true);
  });

  it("isSigningRejected", () => {
    const { message } = decode({
      ...baseEnvelope,
      type: "ac2/SigningRejected",
      body: { reason: "nope" },
    });
    expect(isSigningRejected(message)).toBe(true);
  });

  it("isKeyRequest", () => {
    const { message } = decode({
      ...baseEnvelope,
      type: "ac2/KeyRequest",
      body: { key_type: "ed25519", purpose: "test", for_operation: "test" },
    });
    expect(isKeyRequest(message)).toBe(true);
  });

  it("isKeyResponse", () => {
    const { message } = decode({
      ...baseEnvelope,
      type: "ac2/KeyResponse",
      body: { key_type: "ed25519", public_key: "abc", encoding: "base64" },
    });
    expect(isKeyResponse(message)).toBe(true);
  });

  it("isSessionEstablish", () => {
    const { message } = decode({
      ...baseEnvelope,
      type: "ac2/SessionEstablish",
      body: { protocol_version: "1.0" },
    });
    expect(isSessionEstablish(message)).toBe(true);
  });

  it("isSessionClose", () => {
    const { message } = decode({
      ...baseEnvelope,
      type: "ac2/SessionClose",
      body: {},
    });
    expect(isSessionClose(message)).toBe(true);
  });

  it("isStreamRequest", () => {
    const { message } = decode({
      ...baseEnvelope,
      type: "ac2/StreamRequest",
      body: { stream_id: "s1", content: "hi", content_type: "text" },
    });
    expect(isStreamRequest(message)).toBe(true);
  });

  it("isStreamChunk", () => {
    const { message } = decode({
      ...baseEnvelope,
      type: "ac2/StreamChunk",
      body: { stream_id: "s1", sequence: 0, content: "hi", content_type: "text" },
    });
    expect(isStreamChunk(message)).toBe(true);
  });

  it("isStreamEnd", () => {
    const { message } = decode({
      ...baseEnvelope,
      type: "ac2/StreamEnd",
      body: { stream_id: "s1" },
    });
    expect(isStreamEnd(message)).toBe(true);
  });
});

// ─── handleMessage() ──────────────────────────────────────────────────────────

describe("handleMessage()", () => {
  it("calls onSigningRequest for a SigningRequest", async () => {
    const calls: Array<{ body: { operation: string } }> = [];
    const handler = (msg: { body: { operation: string } }) => {
      calls.push(msg);
    };
    await handleMessage(signingRequestMsg, { onSigningRequest: handler });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.operation).toBe("algorand-txn");
  });

  it("does not call unrelated handlers", async () => {
    let onSigningResponseCalls = 0;
    let onKeyRequestCalls = 0;
    await handleMessage(signingRequestMsg, { onSigningResponse, onKeyRequest });
    function onSigningResponse() {
      onSigningResponseCalls += 1;
    }
    function onKeyRequest() {
      onKeyRequestCalls += 1;
    }
    expect(onSigningResponseCalls).toBe(0);
    expect(onKeyRequestCalls).toBe(0);
  });

  it("calls onSigningRejected correctly", async () => {
    const calls: Array<{ body: { reason: string } }> = [];
    const handler = (msg: { body: { reason: string } }) => {
      calls.push(msg);
    };
    await handleMessage(
      { ...baseEnvelope, type: "ac2/SigningRejected", body: { reason: "User declined" } },
      { onSigningRejected: handler },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.reason).toBe("User declined");
  });

  it("calls onSessionEstablish correctly", async () => {
    const calls: Array<{ body: { protocol_version: string } }> = [];
    const handler = (msg: { body: { protocol_version: string } }) => {
      calls.push(msg);
    };
    await handleMessage(
      { ...baseEnvelope, type: "ac2/SessionEstablish", body: { protocol_version: "1.0" } },
      { onSessionEstablish: handler },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.protocol_version).toBe("1.0");
  });

  it("calls onStreamChunk correctly", async () => {
    const calls: Array<{ body: { sequence: number } }> = [];
    const handler = (msg: { body: { sequence: number } }) => {
      calls.push(msg);
    };
    await handleMessage(
      {
        ...baseEnvelope,
        type: "ac2/StreamChunk",
        body: { stream_id: "s1", sequence: 2, content: "hello", content_type: "text" },
      },
      { onStreamChunk: handler },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.sequence).toBe(2);
  });

  it("calls onUnknown for invalid messages", async () => {
    const calls: Array<[unknown, { valid: boolean }]> = [];
    const handler = (msg: unknown, validation: { valid: boolean }) => {
      calls.push([msg, validation]);
    };
    await handleMessage({ type: "ac2/SigningRequest" }, { onUnknown: handler });
    expect(calls).toHaveLength(1);
    const [, validation] = calls[0]!;
    expect(validation.valid).toBe(false);
  });

  it("returns the validation result", async () => {
    const result = await handleMessage(signingRequestMsg, {});
    expect(result.valid).toBe(true);
    expect(result.messageType).toBe("ac2/SigningRequest");
  });

  it("works with an async handler", async () => {
    const results: string[] = [];
    await handleMessage(signingRequestMsg, {
      onSigningRequest: async (m) => {
        await Promise.resolve();
        results.push(m.body.operation);
      },
    });
    expect(results).toEqual(["algorand-txn"]);
  });
});
