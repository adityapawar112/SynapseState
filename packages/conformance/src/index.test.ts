import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { CONFORMANCE_SUITE_VERSION } from "./index.js";
import {
  canonicalizeJson,
  signLease,
  verifyLease,
  type LeasePayload,
} from "@synapsestate/lease";
import crypto from "node:crypto";

describe("Conformance Suite Core Engine & Property Verification", () => {
  it("exports package version constant", () => {
    expect(CONFORMANCE_SUITE_VERSION).toBe("1.0.0");
  });

  it("verifies RFC 8785 canonicalization idempotency across arbitrary JSON payloads", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            fc.array(fc.string(), { maxLength: 5 })
          )
        ),
        (obj) => {
          const firstPass = canonicalizeJson(obj);
          const parsed = JSON.parse(firstPass);
          const secondPass = canonicalizeJson(parsed);
          return firstPass === secondPass;
        }
      ),
      { numRuns: 100 }
    );
  });

  it("proves that any single-character mutation in a valid signature strictly fails lease verification", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const payload: LeasePayload = {
      v: 1,
      lease_id: "01J9X000000000000000000099",
      env: "test",
      flag_key: "feature-switch-prop",
      value: true,
      reason: "Property testing signature perturbation",
      issued_at: new Date().toISOString(),
      ttl_seconds: 300,
      kid: "test-kid",
      nonce: "test-nonce-1234",
    };
    const validEnvelope = signLease(payload, privateKey);
    expect(verifyLease(validEnvelope, publicKey)).toBe(true);

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: validEnvelope.sig.length - 1 }),
        fc.char().filter((c) => /^[A-Za-z0-9_-]$/.test(c)),
        (charIndex, replacementChar) => {
          if (validEnvelope.sig[charIndex] === replacementChar) {
            return true; // skip identity mutation
          }
          const mutatedSig =
            validEnvelope.sig.slice(0, charIndex) +
            replacementChar +
            validEnvelope.sig.slice(charIndex + 1);

          const mutatedEnvelope = {
            payload,
            sig: mutatedSig,
          };
          return verifyLease(mutatedEnvelope, publicKey) === false;
        }
      ),
      { numRuns: 100 }
    );
  });
});
