import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { CONFORMANCE_SUITE_VERSION } from "./index.js";

describe("Conformance Suite Scaffolding", () => {
  it("exports version", () => {
    expect(CONFORMANCE_SUITE_VERSION).toBe("1.0.0");
  });

  it("verifies property testing runner", () => {
    fc.assert(fc.property(fc.integer(), (n) => n === n));
  });
});
