import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { LEASE_DOMAIN_PREFIX, KEYREVOCATION_DOMAIN_PREFIX } from "./index.js";

describe("Lease Package Scaffolding", () => {
  it("exports valid domain separation prefixes", () => {
    expect(LEASE_DOMAIN_PREFIX).toBe("synapsestate/lease/v1\n");
    expect(KEYREVOCATION_DOMAIN_PREFIX).toBe("synapsestate/keyrevocation/v1\n");
  });

  it("supports fast-check property testing", () => {
    fc.assert(
      fc.property(fc.string(), (str) => {
        return typeof str === "string";
      })
    );
  });
});
