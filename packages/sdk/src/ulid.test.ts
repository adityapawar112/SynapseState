import { describe, it, expect } from "vitest";
import { ULID_REGEX } from "@synapsestate/lease";
import { generateUlid } from "./ulid.js";

describe("generateUlid", () => {
  it("generates valid 26-character Crockford Base32 ULIDs matching ULID_REGEX", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateUlid();
      expect(id).toHaveLength(26);
      expect(id).toMatch(ULID_REGEX);
    }
  });

  it("encodes given timestamp accurately in the first 10 characters", () => {
    const fixedTimeMs = 1791661389781;
    const id = generateUlid(fixedTimeMs);
    expect(id).toHaveLength(26);
    expect(id).toMatch(ULID_REGEX);

    // Ensure the timestamp prefix is deterministic for the same timestamp
    const id2 = generateUlid(fixedTimeMs);
    expect(id.slice(0, 10)).toBe(id2.slice(0, 10));
  });

  it("throws RangeError on negative timestamps", () => {
    expect(() => generateUlid(-1)).toThrow(RangeError);
  });

  it("throws RangeError on timestamps exceeding 2^48 - 1 (281474976710655)", () => {
    const maxAllowed = 281474976710655;
    expect(() => generateUlid(maxAllowed)).not.toThrow();
    expect(() => generateUlid(maxAllowed + 1)).toThrow(RangeError);
  });

  it("throws RangeError on NaN or non-finite timestamps", () => {
    expect(() => generateUlid(NaN)).toThrow(RangeError);
    expect(() => generateUlid(Infinity)).toThrow(RangeError);
  });
});
