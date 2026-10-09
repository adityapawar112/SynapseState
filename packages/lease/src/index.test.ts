import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  LEASE_DOMAIN_PREFIX,
  REVOCATION_DOMAIN_PREFIX,
  KEYREVOCATION_DOMAIN_PREFIX,
  canonicalizeJson,
  LeasePayloadSchema,
  LeaseEnvelopeSchema,
  RevocationPayloadSchema,
  RevocationEnvelopeSchema,
  KeyRevocationPayloadSchema,
  KeyRevocationEnvelopeSchema,
  KeysetSchema,
  signLease,
  verifyLease,
  signRevocation,
  verifyRevocation,
  signKeyRevocation,
  verifyKeyRevocation,
  evaluateLeaseExpiry,
  isLeaseActive,
  parseKeysetJson,
  getKey,
  hasKey,
  isKeyRevoked,
} from "./index.js";

describe("Lease Package Exports & Public API Surface", () => {
  it("exports valid domain separation prefixes", () => {
    expect(LEASE_DOMAIN_PREFIX).toBe("synapsestate/lease/v1\n");
    expect(REVOCATION_DOMAIN_PREFIX).toBe("synapsestate/revocation/v1\n");
    expect(KEYREVOCATION_DOMAIN_PREFIX).toBe("synapsestate/keyrevocation/v1\n");
  });

  it("exports schemas and functions", () => {
    expect(typeof canonicalizeJson).toBe("function");
    expect(LeasePayloadSchema).toBeDefined();
    expect(LeaseEnvelopeSchema).toBeDefined();
    expect(RevocationPayloadSchema).toBeDefined();
    expect(RevocationEnvelopeSchema).toBeDefined();
    expect(KeyRevocationPayloadSchema).toBeDefined();
    expect(KeyRevocationEnvelopeSchema).toBeDefined();
    expect(KeysetSchema).toBeDefined();
    expect(typeof signLease).toBe("function");
    expect(typeof verifyLease).toBe("function");
    expect(typeof signRevocation).toBe("function");
    expect(typeof verifyRevocation).toBe("function");
    expect(typeof signKeyRevocation).toBe("function");
    expect(typeof verifyKeyRevocation).toBe("function");
    expect(typeof evaluateLeaseExpiry).toBe("function");
    expect(typeof isLeaseActive).toBe("function");
    expect(typeof parseKeysetJson).toBe("function");
    expect(typeof getKey).toBe("function");
    expect(typeof hasKey).toBe("function");
    expect(typeof isKeyRevoked).toBe("function");
  });

  it("supports fast-check property testing", () => {
    fc.assert(
      fc.property(fc.string(), (str) => {
        return typeof str === "string";
      }),
    );
  });
});
