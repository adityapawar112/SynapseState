import crypto from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const MAX_ULID_TIME_MS = 281474976710655; // 2^48 - 1 (year 10889 AD)

/**
 * Generates a 26-character Crockford Base32 ULID string.
 * Consists of a 10-character 48-bit timestamp component and a 16-character 80-bit randomness component.
 */
export function generateUlid(nowMs: number = Date.now()): string {
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > MAX_ULID_TIME_MS) {
    throw new RangeError(
      `nowMs must be a finite number between 0 and 2^48 - 1 (${MAX_ULID_TIME_MS})`,
    );
  }

  let time = Math.floor(nowMs);
  let timeStr = "";
  for (let i = 0; i < 10; i++) {
    const mod = time % 32;
    timeStr = ENCODING.charAt(mod) + timeStr;
    time = Math.floor(time / 32);
  }

  // Draw exactly 10 random bytes (80 bits) and pack into 16 5-bit Crockford characters
  const bytes = crypto.randomBytes(10);
  let randStr = "";

  // First 40 bits (bytes 0..4 -> 8 characters)
  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  const b3 = bytes[3];
  const b4 = bytes[4];
  randStr += ENCODING.charAt(b0 >> 3);
  randStr += ENCODING.charAt(((b0 & 7) << 2) | (b1 >> 6));
  randStr += ENCODING.charAt((b1 >> 1) & 31);
  randStr += ENCODING.charAt(((b1 & 1) << 4) | (b2 >> 4));
  randStr += ENCODING.charAt(((b2 & 15) << 1) | (b3 >> 7));
  randStr += ENCODING.charAt((b3 >> 2) & 31);
  randStr += ENCODING.charAt(((b3 & 3) << 3) | (b4 >> 5));
  randStr += ENCODING.charAt(b4 & 31);

  // Second 40 bits (bytes 5..9 -> 8 characters)
  const b5 = bytes[5];
  const b6 = bytes[6];
  const b7 = bytes[7];
  const b8 = bytes[8];
  const b9 = bytes[9];
  randStr += ENCODING.charAt(b5 >> 3);
  randStr += ENCODING.charAt(((b5 & 7) << 2) | (b6 >> 6));
  randStr += ENCODING.charAt((b6 >> 1) & 31);
  randStr += ENCODING.charAt(((b6 & 1) << 4) | (b7 >> 4));
  randStr += ENCODING.charAt(((b7 & 15) << 1) | (b8 >> 7));
  randStr += ENCODING.charAt((b8 >> 2) & 31);
  randStr += ENCODING.charAt(((b8 & 3) << 3) | (b9 >> 5));
  randStr += ENCODING.charAt(b9 & 31);

  return timeStr + randStr;
}
