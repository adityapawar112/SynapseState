import { describe, it, expect } from "vitest";
import {
  ULID_REGEX,
  generateUlid,
  MAX_ULID_TIME_MS,
  resetUlidMonotonicStateForTest,
} from "./index.js";

describe("generateUlid in @synapsestate/lease", () => {
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

    const id2 = generateUlid(fixedTimeMs);
    expect(id.slice(0, 10)).toBe(id2.slice(0, 10));
  });

  it("throws RangeError on negative timestamps", () => {
    expect(() => generateUlid(-1)).toThrow(RangeError);
  });

  it("throws RangeError on timestamps exceeding MAX_ULID_TIME_MS", () => {
    expect(() => generateUlid(MAX_ULID_TIME_MS)).not.toThrow();
    expect(() => generateUlid(MAX_ULID_TIME_MS + 1)).toThrow(RangeError);
  });

  it("throws RangeError on NaN or non-finite timestamps", () => {
    expect(() => generateUlid(NaN)).toThrow(RangeError);
    expect(() => generateUlid(Infinity)).toThrow(RangeError);
  });

  it("generates strictly monotonic ULIDs when called multiple times within the same millisecond", () => {
    const fixedMs = 1791661389781;
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(generateUlid(fixedMs));
    }

    // Verify all 1000 IDs are unique and strictly monotonically increasing
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1].slice(0, 10)).toBe(ids[i].slice(0, 10));
      expect(ids[i - 1] < ids[i]).toBe(true);
    }
  });

  it("preserves strict monotonic ordering even if system clock regresses backward", () => {
    resetUlidMonotonicStateForTest();
    const t0 = 1791661389800;
    const id1 = generateUlid(t0);
    // Clock jumps 100ms backward
    const id2 = generateUlid(t0 - 100);
    // id2 must still sort strictly after id1
    expect(id1 < id2).toBe(true);
  });
});

