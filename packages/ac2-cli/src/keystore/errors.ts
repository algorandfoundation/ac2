/** Decoding of a stored key blob failed. */
export class DecodingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DecodingError';
    if (cause) (this as { cause?: unknown }).cause = cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, DecodingError);
  }
}

/** Unlocking the legacy keystore (fetching its master key) failed. */
export class UnlockingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'UnlockingError';
    if (cause) (this as { cause?: unknown }).cause = cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, UnlockingError);
  }
}
