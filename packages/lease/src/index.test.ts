import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  LEASE_DOMAIN_PREFIX,
  REVOCATION_DOMAIN_PREFIX,
  KEYREVOCATION_DOMAIN_PREFIX,
  canonicalizeJson,
  KID_REGEX,
  FORBIDDEN_KID_NAMES,
  KidSchema,
  KEY_ROLE_VALUES,
  KEY_STATUS_VALUES,
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
  isKeyActive,
  canSignLease,
  canRevokeLease,
  canRevokeKey,
  isKeyRevoked,
  verifyLeaseWithKeyset,
  verifyRevocationWithKeyset,
  verifyKeyRevocationWithKeyset,
  rankSuspects,
  quoteShellArg,
} from "./index.js";

describe("Lease Package Exports & Public API Surface", () => {
  it("exports valid domain separation prefixes", () => {
    expect(LEASE_DOMAIN_PREFIX).toBe("synapsestate/lease/v1\n");
    expect(REVOCATION_DOMAIN_PREFIX).toBe("synapsestate/revocation/v1\n");
    expect(KEYREVOCATION_DOMAIN_PREFIX).toBe("synapsestate/keyrevocation/v1\n");
  });

  it("exports schemas, regexes, and constants", () => {
    expect(typeof canonicalizeJson).toBe("function");
    expect(KID_REGEX).toBeInstanceOf(RegExp);
    expect(FORBIDDEN_KID_NAMES).toContain("__proto__");
    expect(KidSchema).toBeDefined();
    expect(KEY_ROLE_VALUES).toContain("lease_signer");
    expect(KEY_STATUS_VALUES).toContain("active");
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
    expect(typeof isKeyActive).toBe("function");
    expect(typeof canSignLease).toBe("function");
    expect(typeof canRevokeLease).toBe("function");
    expect(typeof canRevokeKey).toBe("function");
    expect(typeof isKeyRevoked).toBe("function");
    expect(typeof verifyLeaseWithKeyset).toBe("function");
    expect(typeof verifyRevocationWithKeyset).toBe("function");
    expect(typeof verifyKeyRevocationWithKeyset).toBe("function");
    expect(typeof rankSuspects).toBe("function");
    expect(typeof quoteShellArg).toBe("function");
  });

  it("supports fast-check property testing", () => {
    fc.assert(
      fc.property(fc.string(), (str) => {
        return typeof str === "string";
      }),
    );
  });
});
