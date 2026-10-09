import { describe, it, expect } from "vitest";
import { LEASE_DOMAIN_PREFIX } from "./index.js";

describe("SDK Package Scaffolding", () => {
  it("exports lease prefix from lease package", () => {
    expect(LEASE_DOMAIN_PREFIX).toBe("synapsestate/lease/v1\n");
  });
});
