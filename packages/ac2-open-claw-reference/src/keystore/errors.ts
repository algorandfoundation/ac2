/** Decoding of a stored key blob failed. */
export class DecodingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DecodingError';
    if (cause) (this as { cause?: unknown }).cause = cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, DecodingError);
  }
}

/** Encoding of a key for storage failed. */
export class EncodingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'EncodingError';
    if (cause) (this as { cause?: unknown }).cause = cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, EncodingError);
  }
}

/** Unlocking the keystore (fetching the master key) failed. */
export class UnlockingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'UnlockingError';
    if (cause) (this as { cause?: unknown }).cause = cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, UnlockingError);
  }
}
