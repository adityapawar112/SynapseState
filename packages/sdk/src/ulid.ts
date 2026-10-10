import crypto from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generates a 26-character Crockford Base32 ULID string.
 * Consists of a 10-character timestamp component and a 16-character randomness component.
 */
export function generateUlid(nowMs: number = Date.now()): string {
  let timeStr = "";
  let time = Math.floor(nowMs);
  for (let i = 0; i < 10; i++) {
    const mod = time % 32;
    timeStr = ENCODING.charAt(mod) + timeStr;
    time = Math.floor(time / 32);
  }

  const randomBytes = crypto.randomBytes(16);
  let randStr = "";
  for (let i = 0; i < 16; i++) {
    randStr += ENCODING.charAt(randomBytes[i] % 32);
  }

  return timeStr + randStr;
}
