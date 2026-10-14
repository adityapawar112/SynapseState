import crypto from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const MAX_ULID_TIME_MS = 281474976710655; // 2^48 - 1 (year 10889 AD)

let lastTimeMs = -1;
const lastRand = new Uint8Array(10);

/**
 * Resets internal monotonic state. Used primarily for deterministic test isolation.
 */
export function resetUlidMonotonicStateForTest(): void {
  lastTimeMs = -1;
  lastRand.fill(0);
}

/**
 * Generates a 26-character Crockford Base32 ULID string.
 * Consists of a 10-character 48-bit timestamp component and a 16-character 80-bit randomness component.
 *
 * Implements monotonic ULID generation:
 * - If called multiple times within the exact same millisecond, the 80-bit randomness component
 *   is incremented by 1, guaranteeing strict lexicographic sorting order.
 * - On 80-bit overflow within the same millisecond, the timestamp component increments by 1ms.
 */
export function generateUlid(nowMs: number = Date.now()): string {
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > MAX_ULID_TIME_MS) {
    throw new RangeError(
      `nowMs must be a finite number between 0 and 2^48 - 1 (${MAX_ULID_TIME_MS})`,
    );
  }

  let time = Math.floor(nowMs);
  let bytes: Uint8Array;

  if (time <= lastTimeMs) {
    // If called in same millisecond or clock moved backward (NTP regression),
    // clamp to lastTimeMs and increment 80-bit counter to preserve strict monotonic ordering
    time = lastTimeMs;
    let carry = 1;
    for (let i = 9; i >= 0 && carry > 0; i--) {
      const sum = lastRand[i] + carry;
      lastRand[i] = sum & 0xff;
      carry = sum >> 8;
    }

    if (carry > 0) {
      // 80-bit random counter overflowed in same ms; increment timestamp by 1ms and draw fresh random
      time += 1;
      bytes = crypto.randomBytes(10);
      lastRand.set(bytes);
    } else {
      bytes = new Uint8Array(lastRand);
    }
  } else {
    bytes = crypto.randomBytes(10);
    lastRand.set(bytes);
  }
  lastTimeMs = time;

  let timeStr = "";
  let tempTime = time;
  for (let i = 0; i < 10; i++) {
    const mod = tempTime % 32;
    timeStr = ENCODING.charAt(mod) + timeStr;
    tempTime = Math.floor(tempTime / 32);
  }

  // Pack 10 bytes (80 bits) into 16 5-bit Crockford characters
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
