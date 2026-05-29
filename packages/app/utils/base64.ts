/**
 * Utility functions for Base64 and URL-safe Base64 conversion.
 */

/**
 * Converts a string to URL-safe Base64 by replacing + with -, / with _, and removing = padding.
 *
 * @param base64 - Standard Base64 string.
 * @returns URL-safe Base64 string.
 */
export const toUrlSafe = (base64: string): string => {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

/**
 * Converts a URL-safe Base64 string back to standard Base64 by restoring padding and special characters.
 *
 * @param urlSafeBase64 - URL-safe Base64 string.
 * @returns Standard Base64 string.
 */
export const fromUrlSafe = (urlSafeBase64: string): string => {
  let base64 = urlSafeBase64.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return base64;
};
