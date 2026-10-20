import { describe, it, expect } from "vitest";
import { canonicalizeJson } from "./canonicalize.js";

describe("canonicalizeJson (RFC 8785 / JCS)", () => {
  describe("object key sorting (UTF-16 code unit ordering)", () => {
    it("sorts basic ASCII keys lexicographically", () => {
      expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
      expect(canonicalizeJson({ z: 1, m: 2, a: 3 })).toBe(
        '{"a":3,"m":2,"z":1}',
      );
    });

    it("sorts numeric string keys lexicographically, not numerically", () => {
      // In UTF-16, "10" < "2" because '1' (0x31) < '2' (0x32)
      expect(canonicalizeJson({ "2": 2, "10": 10 })).toBe('{"10":10,"2":2}');
      expect(canonicalizeJson({ "20": 1, "100": 2, "3": 3 })).toBe(
        '{"100":2,"20":1,"3":3}',
      );
    });

    it("sorts uppercase before lowercase ASCII", () => {
      // 'A' (0x41) < 'a' (0x61)
      expect(canonicalizeJson({ b: 1, A: 2, a: 3 })).toBe(
        '{"A":2,"a":3,"b":1}',
      );
    });

    it("sorts Unicode keys strictly by UTF-16 code units", () => {
      // 'a' (0x0061) < Euro '€' (0x20AC)
      expect(canonicalizeJson({ "\u20ac": 1, a: 2 })).toBe(
        '{"a":2,"\u20ac":1}',
      );
      // '€' (0x20AC) < 'é' (0x00E9 in standard sorting: wait, 0x00E9 < 0x20AC)
      expect(canonicalizeJson({ "\u20ac": 1, "\u00e9": 2 })).toBe(
        '{"\u00e9":2,"\u20ac":1}',
      );
    });

    it("recursively sorts keys in nested objects", () => {
      const input = {
        z: { y: 1, x: 2 },
        a: { c: 3, b: 4 },
      };
      expect(canonicalizeJson(input)).toBe(
        '{"a":{"b":4,"c":3},"z":{"x":2,"y":1}}',
      );
    });

    it("handles nested arrays containing objects with out-of-order keys", () => {
      const input = [
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ];
      expect(canonicalizeJson(input)).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
    });
  });

  describe("number formatting (ECMAScript specification compliance)", () => {
    it("serializes -0 as 0", () => {
      expect(canonicalizeJson(-0)).toBe("0");
      expect(canonicalizeJson({ val: -0 })).toBe('{"val":0}');
    });

    it("serializes integers without scientific notation or trailing zeros", () => {
      expect(canonicalizeJson(0)).toBe("0");
      expect(canonicalizeJson(42)).toBe("42");
      expect(canonicalizeJson(-100)).toBe("-100");
      expect(canonicalizeJson(Number.MAX_SAFE_INTEGER)).toBe(
        "9007199254740991",
      );
      expect(canonicalizeJson(Number.MIN_SAFE_INTEGER)).toBe(
        "-9007199254740991",
      );
    });

    it("serializes floating point numbers deterministically", () => {
      expect(canonicalizeJson(1.5)).toBe("1.5");
      expect(canonicalizeJson(0.000001)).toBe("0.000001");
      expect(canonicalizeJson(1e-7)).toBe("1e-7");
      expect(canonicalizeJson(1e21)).toBe("1e+21");
    });
  });

  describe("whitespace and structure invariants", () => {
    it("omits all whitespace between tokens", () => {
      const input = {
        key: "value",
        list: [1, 2, 3],
        nested: { inner: true },
      };
      const result = canonicalizeJson(input);
      expect(result).not.toMatch(/\s/);
      expect(result).toBe(
        '{"key":"value","list":[1,2,3],"nested":{"inner":true}}',
      );
    });

    it("handles empty structures cleanly", () => {
      expect(canonicalizeJson({})).toBe("{}");
      expect(canonicalizeJson([])).toBe("[]");
      expect(canonicalizeJson({ emptyObj: {}, emptyArr: [] })).toBe(
        '{"emptyArr":[],"emptyObj":{}}',
      );
    });

    it("does not escape forward slashes", () => {
      const input = { url: "https://example.com/api/v1?test=1" };
      expect(canonicalizeJson(input)).toBe(
        '{"url":"https://example.com/api/v1?test=1"}',
      );
      expect(canonicalizeJson(input)).not.toContain("\\/");
    });

    it("correctly escapes quotes, backslashes, and control characters", () => {
      const input = {
        quotes: 'hello "world"',
        backslash: "path\\to\\file",
        newline: "line1\nline2",
        tab: "col1\tcol2",
      };
      expect(canonicalizeJson(input)).toBe(
        '{"backslash":"path\\\\to\\\\file","newline":"line1\\nline2","quotes":"hello \\"world\\"","tab":"col1\\tcol2"}',
      );
    });
  });

  describe("error handling and invalid inputs", () => {
    it("throws TypeError on undefined", () => {
      expect(() => canonicalizeJson(undefined)).toThrowError(
        "Cannot canonicalize undefined value into JSON",
      );
    });

    it("rejects NaN and Infinity", () => {
      expect(() => canonicalizeJson(NaN)).toThrow();
      expect(() => canonicalizeJson(Infinity)).toThrow();
      expect(() => canonicalizeJson(-Infinity)).toThrow();
      expect(() => canonicalizeJson({ val: NaN })).toThrow();
    });
  });
});
