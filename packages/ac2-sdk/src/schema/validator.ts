import type { ErrorObject } from 'ajv';
import Ajv from 'ajv';
import { baseMessageSchema } from './definitions/base.js';
import { keyRequestBodySchema, keyResponseBodySchema } from './definitions/key.js';
import { signingRequestBodySchema, signingResponseBodySchema } from './definitions/signing.js';

import type { ValidationResult } from './types.js';
import { AC2MessageTypes } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const draftValidate = ajv.compile(baseMessageSchema);

const bodySchemas = {
  [AC2MessageTypes.SIGNING_REQUEST]: signingRequestBodySchema,
  [AC2MessageTypes.SIGNING_RESPONSE]: signingResponseBodySchema,
  [AC2MessageTypes.KEY_REQUEST]: keyRequestBodySchema,
  [AC2MessageTypes.KEY_RESPONSE]: keyResponseBodySchema,
} as const;

// ─── Compiled validators (created once, reused) ───────────────────────────────

const bodyValidators = Object.fromEntries(
  Object.entries(bodySchemas).map(([messageType, schema]) => [messageType, ajv.compile(schema)]),
) as Record<keyof typeof bodySchemas, ReturnType<typeof ajv.compile>>;

const KNOWN_TYPES = new Set<string>(Object.keys(bodySchemas));

function isKnownBodyType(type: string): type is keyof typeof bodyValidators {
  return type in bodyValidators;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate a raw (unknown) value as an AC2 message.
 *
 * Performs two-pass validation:
 *  1. Base DIDComm v2 envelope structure (id, type, from, to, created_time, body)
 *  2. Body against the registered schema for the declared `type`
 *
 * Returns errors for hard violations, warnings for spec advisory issues.
 */
export function validate(payload: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (payload === null || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload must be a non-null object'], warnings };
  }

  // Pass 1 — base envelope
  if (!draftValidate(payload) && draftValidate.errors) {
    for (const err of draftValidate.errors) {
      errors.push(formatAjvError(err));
    }
  }

  const msg = payload as Record<string, unknown>;
  const messageType = typeof msg.type === 'string' ? msg.type : undefined;

  // Warn on unrecognised type (forward-compatibility: don't error)
  if (messageType !== undefined && !KNOWN_TYPES.has(messageType)) {
    warnings.push(`Unknown message type: "${messageType}"`);
  }

  // Warn on expired message
  if (typeof msg.expires_time === 'number' && msg.expires_time < Date.now() / 1000) {
    warnings.push(
      `Message has expired (expires_time: ${msg.expires_time}, now: ${Math.floor(Date.now() / 1000)})`,
    );
  }

  // Pass 2 — body for known types
  if (
    messageType &&
    isKnownBodyType(messageType) &&
    typeof msg.body === 'object' &&
    msg.body !== null
  ) {
    const bodyValidator = bodyValidators[messageType];
    if (!bodyValidator(msg.body) && bodyValidator.errors) {
      for (const err of bodyValidator.errors) {
        errors.push(`body ${formatAjvError(err)}`);
      }
    }
  }

  const result: ValidationResult = { valid: errors.length === 0, errors, warnings };
  if (messageType !== undefined) result.messageType = messageType;
  return result;
}

/**
 * Validate a pre-parsed object as an AC2 message.
 * Alias for `validate` with a narrowed input type.
 */
export function validateMessage(message: Record<string, unknown>): ValidationResult {
  return validate(message);
}

/**
 * Validate only the body object for a specific AC2 message type.
 *
 * Returns `valid: true` with a warning for unknown types so that
 * forward-compatible code does not break on new message types.
 */
export function validateBody(type: string, body: unknown): ValidationResult {
  if (!isKnownBodyType(type)) {
    return {
      valid: true,
      errors: [],
      warnings: [`No body schema registered for type: "${type}"`],
    };
  }

  const errors: string[] = [];
  const bodyValidator = bodyValidators[type];

  if (!bodyValidator(body) && bodyValidator.errors) {
    for (const err of bodyValidator.errors) {
      errors.push(formatAjvError(err));
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAjvError(err: ErrorObject): string {
  const path = err.instancePath ? ` ${err.instancePath}` : '';
  return `${path} ${err.message ?? 'unknown error'}`.trim();
}
