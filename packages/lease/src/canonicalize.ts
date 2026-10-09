import canonicalizeRaw from "canonicalize";

type CanonicalizeFn = (input: unknown) => string | undefined;

// Handle NodeNext CJS/ESM interop differences
const serialize: CanonicalizeFn =
  typeof canonicalizeRaw === "function"
    ? canonicalizeRaw
    : (canonicalizeRaw as unknown as { default: CanonicalizeFn }).default;

/**
 * Serializes an object or primitive into deterministic, canonical JSON according to RFC 8785 (JCS).
 * - Enforces deterministic UTF-16 code unit key ordering
 * - Eliminates all extraneous whitespace
 * - Rejects NaN and Infinity
 * - Formats floats according to ECMAScript standard
 */
export function canonicalizeJson(input: unknown): string {
  const result = serialize(input);
  if (result === undefined) {
    throw new TypeError("Cannot canonicalize undefined value into JSON");
  }
  return result;
}
