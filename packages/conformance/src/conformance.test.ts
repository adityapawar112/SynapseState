import { describe, it, expect } from "vitest";
import {
  runConformanceSuite,
  loadTrustedKeyset,
  runKeysetVectors,
  runLeaseVectors,
  runRevocationVectors,
  runKeyRevocationVectors,
  readFixtureJson,
} from "./runner.js";
import {
  parseKeysetJson,
  getKey,
  canRevokeKey,
  canonicalizeJson,
  verifyLease,
  verifyRevocation,
  verifyKeyRevocation,
  verifyLeaseWithKeyset,
  verifyRevocationWithKeyset,
  verifyKeyRevocationWithKeyset,
  verifyEnvelope,
  evaluateLeaseExpiry,
  isLeaseActive,
  REVOCATION_DOMAIN_PREFIX,
  KEYREVOCATION_DOMAIN_PREFIX,
  LEASE_DOMAIN_PREFIX,
  type LeaseEnvelope,
  type RevocationEnvelope,
  type KeyRevocationEnvelope,
} from "@synapsestate/lease";
import type {
  ValidLeaseVector,
  InvalidLeaseVector,
  ValidRevocationVector,
  InvalidRevocationVector,
  ValidKeyRevocationVector,
  InvalidKeyRevocationVector,
} from "./types.js";

describe("Language-Neutral Conformance Golden Vectors & Runner", () => {
  describe("Trusted Keyset Vectors (fixtures/keysets/)", () => {
    it("loads and verifies the authoritative trusted keyset", () => {
      const keyset = loadTrustedKeyset();
      expect(keyset).toBeDefined();
      expect(Object.keys(keyset).length).toBe(4);
      expect(keyset["ops-primary-01"]).toBeDefined();
      expect(keyset["ops-primary-01"]?.role).toBe("operator");
      expect(keyset["ops-primary-01"]?.max_ttl_seconds).toBe(3600);
      expect(keyset["ops-secondary-02"]?.role).toBe("operator");
      expect(keyset["ops-secondary-02"]?.max_ttl_seconds).toBe(7200);
      expect(keyset["admin-root-01"]).toBeDefined();
      expect(keyset["admin-root-01"]?.role).toBe("admin");
      expect(keyset["admin-backup-02"]?.role).toBe("admin");
    });

    it("verifies empty keyset parses as authoritative 0-key revocation directive", () => {
      const parsedEmpty = parseKeysetJson("{}");
      expect(parsedEmpty).toEqual({});

      const report = runKeysetVectors();
      const emptyResult = report.results.find(
        (r) => r.vectorId === "empty_keyset_authoritative_revocation",
      );
      expect(emptyResult).toBeDefined();
      expect(emptyResult?.passed).toBe(true);
      expect(emptyResult?.actualStatus).toBe("VALID_EMPTY");
    });

    it("verifies all invalid keyset test vectors fail parsing or validation as expected", () => {
      const invalidFixtures = readFixtureJson<{
        cases: Array<{
          id: string;
          description: string;
          raw: string;
          expectedError: string;
        }>;
      }>("keysets/invalid_keyset.json");
      expect(invalidFixtures.cases.length).toBe(9);

      // Direct invariant verification on each raw vector
      for (const c of invalidFixtures.cases) {
        expect(() => parseKeysetJson(c.raw)).toThrowError();
        try {
          parseKeysetJson(c.raw);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as Error).name).toBe(c.expectedError);
          expect((err as Error).message.length).toBeGreaterThan(0);
        }
      }

      // Runner verification
      const report = runKeysetVectors();
      expect(report.total).toBe(11); // valid + empty + 9 invalid cases
      expect(report.failed).toBe(0);
      expect(report.passed).toBe(11);
    });
  });

  describe("Emergency Lease Vectors (fixtures/leases/)", () => {
    it("verifies 100% of valid leases pass envelope, keyset seam, signature, and dual-clock validation", () => {
      const validFixtures = readFixtureJson<{ cases: ValidLeaseVector[] }>(
        "leases/valid_leases.json",
      );
      expect(validFixtures.cases.length).toBe(5);
      const trustedKeyset = loadTrustedKeyset();

      // Direct verification on each valid lease fixture
      for (const validCase of validFixtures.cases) {
        const key = getKey(trustedKeyset, validCase.envelope.payload.kid);
        expect(key).toBeDefined();
        // Cryptographic verification
        expect(verifyLease(validCase.envelope, key!.public_key)).toBe(true);
        // Authoritative keyset policy seam verification
        expect(verifyLeaseWithKeyset(validCase.envelope, trustedKeyset)).toBe(
          true,
        );

        // Deterministic RFC 8785 canonical serialization verification
        if (validCase.expected.canonicalPayload) {
          expect(canonicalizeJson(validCase.envelope.payload)).toBe(
            validCase.expected.canonicalPayload,
          );
        }

        expect(validCase.envelope.payload.flag_key).toBe(
          validCase.expected.flagKey,
        );
        expect(validCase.envelope.payload.value).toEqual(
          validCase.expected.resolvedValue,
        );
        expect(validCase.envelope.payload.kid).toBe(validCase.expected.kid);

        if (validCase.clockParams) {
          const evalResult = evaluateLeaseExpiry({
            issuedAt: validCase.envelope.payload.issued_at,
            ttlSeconds: validCase.envelope.payload.ttl_seconds,
            ...validCase.clockParams,
          });
          expect(evalResult.isValid).toBe(true);
          expect(evalResult.status).toBe("VALID");
          expect(evalResult.remainingEffectiveMs).toBeGreaterThan(0);
          expect(
            isLeaseActive({
              issuedAt: validCase.envelope.payload.issued_at,
              ttlSeconds: validCase.envelope.payload.ttl_seconds,
              ...validCase.clockParams,
            }),
          ).toBe(true);
        }
      }

      const report = runLeaseVectors();
      for (const validCase of validFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === validCase.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe("VALID");
      }
    });

    it("verifies tampered payload leases fail cryptographic verification", () => {
      const tamperedFixtures = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
        "leases/tampered_payload_leases.json",
      );
      expect(tamperedFixtures.cases.length).toBe(8);
      const trustedKeyset = loadTrustedKeyset();

      // Direct verification: check that signature check strictly returns false on altered payload
      for (const tc of tamperedFixtures.cases) {
        const envelope = tc.envelope as LeaseEnvelope;
        const key = getKey(trustedKeyset, envelope.payload.kid);
        expect(key).toBeDefined();
        expect(verifyLease(envelope, key!.public_key)).toBe(false);
        expect(verifyLeaseWithKeyset(envelope, trustedKeyset)).toBe(false);
      }

      const report = runLeaseVectors();
      for (const tc of tamperedFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === tc.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe("SIGNATURE_INVALID");
      }
    });

    it("verifies tampered signature leases fail schema validation or cryptographic verification (including base64url malleability)", () => {
      const tamperedSigFixtures = readFixtureJson<{
        cases: InvalidLeaseVector[];
      }>("leases/tampered_sig_leases.json");
      expect(tamperedSigFixtures.cases.length).toBe(6);

      // Verify canonical-base64url malleability vector specifically
      const malleabilityCase = tamperedSigFixtures.cases.find(
        (c) => c.id === "tampered_sig_canonical_base64url_malleability",
      );
      expect(malleabilityCase).toBeDefined();
      const malleatedEnvelope = malleabilityCase!.envelope as LeaseEnvelope;
      const trustedKeyset = loadTrustedKeyset();
      const key = getKey(trustedKeyset, malleatedEnvelope.payload.kid);
      expect(key).toBeDefined();
      // Raw 64-byte decoding is identical, but non-canonical padding bits must cause failure
      expect(Buffer.from(malleatedEnvelope.sig, "base64url").length).toBe(64);
      expect(verifyLease(malleatedEnvelope, key!.public_key)).toBe(false);
      expect(verifyLeaseWithKeyset(malleatedEnvelope, trustedKeyset)).toBe(
        false,
      );

      const report = runLeaseVectors();
      for (const tc of tamperedSigFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === tc.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe(tc.expectedFailure);
      }
    });

    it("verifies leases signed by unknown kid not in keyset are rejected under keyset-policy seam", () => {
      const unknownKidFixtures = readFixtureJson<{
        cases: InvalidLeaseVector[];
      }>("leases/unknown_kid_leases.json");
      expect(unknownKidFixtures.cases.length).toBe(1);
      const trustedKeyset = loadTrustedKeyset();

      const unknownCase = unknownKidFixtures.cases[0]!;
      const envelope = unknownCase.envelope as LeaseEnvelope;
      // Precondition: key is genuinely missing from trusted keyset
      expect(getKey(trustedKeyset, envelope.payload.kid)).toBeUndefined();
      // Keyset-policy seam must reject it
      expect(verifyLeaseWithKeyset(envelope, trustedKeyset)).toBe(false);

      const report = runLeaseVectors();
      const result = report.results.find((r) => r.vectorId === unknownCase.id);
      expect(result).toBeDefined();
      expect(result?.passed).toBe(true);
      expect(result?.actualStatus).toBe("UNKNOWN_KEY");
    });

    it("enforces Domain Separation Invariant: cross-domain signed leases fail verification", () => {
      const crossDomainFixtures = readFixtureJson<{
        cases: InvalidLeaseVector[];
      }>("leases/cross_domain_leases.json");
      expect(crossDomainFixtures.cases.length).toBe(4);
      const trustedKeyset = loadTrustedKeyset();

      // Direct verification: Prove that the signature IS valid under its source domain, but REJECTED as a lease
      for (const tc of crossDomainFixtures.cases) {
        const envelope = tc.envelope as LeaseEnvelope;
        const key = getKey(trustedKeyset, envelope.payload.kid);
        expect(key).toBeDefined();
        // 1. Must fail lease verification
        expect(verifyLease(envelope, key!.public_key)).toBe(false);
        expect(verifyLeaseWithKeyset(envelope, trustedKeyset)).toBe(false);

        // 2. Must pass under the actual domain used to sign it
        if (tc.id === "cross_domain_signed_with_revocation_prefix") {
          expect(
            verifyEnvelope(REVOCATION_DOMAIN_PREFIX, envelope, key!.public_key),
          ).toBe(true);
        } else if (tc.id === "cross_domain_signed_with_keyrevocation_prefix") {
          expect(
            verifyEnvelope(
              KEYREVOCATION_DOMAIN_PREFIX,
              envelope,
              key!.public_key,
            ),
          ).toBe(true);
        } else if (tc.id === "cross_domain_signed_with_bogus_prefix") {
          expect(
            verifyEnvelope(
              "synapsestate/audit/v1\n",
              envelope,
              key!.public_key,
            ),
          ).toBe(true);
        } else if (tc.id === "cross_domain_signed_with_empty_prefix") {
          expect(verifyEnvelope("", envelope, key!.public_key)).toBe(true);
        }
      }

      const report = runLeaseVectors();
      for (const tc of crossDomainFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === tc.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe("DOMAIN_SEPARATION_MISMATCH");
      }
    });

    it("enforces Dual-Clock Expiry Invariant: expired wall clock and monotonic leases fail-static", () => {
      const expiredFixtures = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
        "leases/expired_wall_clock_leases.json",
      );
      expect(expiredFixtures.cases.length).toBe(4);
      const trustedKeyset = loadTrustedKeyset();

      for (const tc of expiredFixtures.cases) {
        const envelope = tc.envelope as LeaseEnvelope;
        const key = getKey(trustedKeyset, envelope.payload.kid);
        expect(key).toBeDefined();
        // Cryptographic signature & keyset policy are authentic
        expect(verifyLease(envelope, key!.public_key)).toBe(true);
        expect(verifyLeaseWithKeyset(envelope, trustedKeyset)).toBe(true);

        // Expiry evaluation strictly marks lease invalid
        const evalResult = evaluateLeaseExpiry({
          issuedAt: envelope.payload.issued_at,
          ttlSeconds: envelope.payload.ttl_seconds,
          ...tc.clockParams!,
        });
        expect(evalResult.isValid).toBe(false);
        expect(evalResult.status).toBe(tc.expectedFailure);
        expect(evalResult.remainingEffectiveMs).toBe(0);
        expect(
          isLeaseActive({
            issuedAt: envelope.payload.issued_at,
            ttlSeconds: envelope.payload.ttl_seconds,
            ...tc.clockParams!,
          }),
        ).toBe(false);
      }

      const report = runLeaseVectors();
      for (const tc of expiredFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === tc.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe(tc.expectedFailure);
      }
    });

    it("enforces Anti-Future Skew Check: future-dated leases beyond tolerance are rejected", () => {
      const futureFixtures = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
        "leases/future_dated_leases.json",
      );
      expect(futureFixtures.cases.length).toBe(2);
      const trustedKeyset = loadTrustedKeyset();

      for (const tc of futureFixtures.cases) {
        const envelope = tc.envelope as LeaseEnvelope;
        const key = getKey(trustedKeyset, envelope.payload.kid);
        expect(key).toBeDefined();
        expect(verifyLease(envelope, key!.public_key)).toBe(true);
        expect(verifyLeaseWithKeyset(envelope, trustedKeyset)).toBe(true);

        const evalResult = evaluateLeaseExpiry({
          issuedAt: envelope.payload.issued_at,
          ttlSeconds: envelope.payload.ttl_seconds,
          ...tc.clockParams!,
        });
        expect(evalResult.isValid).toBe(false);
        expect(evalResult.status).toBe("FUTURE_DATED");
        expect(
          isLeaseActive({
            issuedAt: envelope.payload.issued_at,
            ttlSeconds: envelope.payload.ttl_seconds,
            ...tc.clockParams!,
          }),
        ).toBe(false);
      }

      const report = runLeaseVectors();
      for (const tc of futureFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === tc.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe("FUTURE_DATED");
      }
    });
  });

  describe("Revocation Vectors (fixtures/revocations/)", () => {
    it("verifies 100% of valid lease revocations pass verification", () => {
      const validFixtures = readFixtureJson<{ cases: ValidRevocationVector[] }>(
        "revocations/valid_revocations.json",
      );
      expect(validFixtures.cases.length).toBe(2);
      const trustedKeyset = loadTrustedKeyset();

      for (const vc of validFixtures.cases) {
        const key = getKey(trustedKeyset, vc.envelope.payload.kid);
        expect(key).toBeDefined();
        expect(verifyRevocation(vc.envelope, key!.public_key)).toBe(true);
        expect(verifyRevocationWithKeyset(vc.envelope, trustedKeyset)).toBe(
          true,
        );
        if (vc.expected.canonicalPayload) {
          expect(canonicalizeJson(vc.envelope.payload)).toBe(
            vc.expected.canonicalPayload,
          );
        }
        expect(vc.envelope.payload.lease_id).toBe(vc.expected.leaseId);
        expect(vc.envelope.payload.kid).toBe(vc.expected.kid);
      }

      const report = runRevocationVectors();
      for (const vc of validFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === vc.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe("VALID");
      }
    });

    it("verifies invalid lease revocations fail verification with expected reasons", () => {
      const invalidFixtures = readFixtureJson<{
        cases: InvalidRevocationVector[];
      }>("revocations/invalid_revocations.json");
      expect(invalidFixtures.cases.length).toBe(5);
      const trustedKeyset = loadTrustedKeyset();

      // Check cross-domain revocation vector mathematically
      const crossDomainRev = invalidFixtures.cases.find(
        (c) => c.id === "revocation_cross_domain_lease_prefix",
      );
      expect(crossDomainRev).toBeDefined();
      const crossEnvelope = crossDomainRev!.envelope as RevocationEnvelope;
      const crossKey = getKey(trustedKeyset, crossEnvelope.payload.kid);
      expect(crossKey).toBeDefined();
      expect(verifyRevocation(crossEnvelope, crossKey!.public_key)).toBe(false);
      expect(verifyRevocationWithKeyset(crossEnvelope, trustedKeyset)).toBe(
        false,
      );
      expect(
        verifyEnvelope(
          LEASE_DOMAIN_PREFIX,
          crossEnvelope,
          crossKey!.public_key,
        ),
      ).toBe(true);

      const report = runRevocationVectors();
      for (const ic of invalidFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === ic.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe(ic.expectedFailure);
      }
    });
  });

  describe("Key Revocation Vectors (fixtures/key_revocations/)", () => {
    it("verifies 100% of valid key revocations pass verification", () => {
      const validFixtures = readFixtureJson<{
        cases: ValidKeyRevocationVector[];
      }>("key_revocations/valid_key_revocations.json");
      expect(validFixtures.cases.length).toBe(2);
      const trustedKeyset = loadTrustedKeyset();

      for (const vc of validFixtures.cases) {
        const signerKid = vc.envelope.payload.revoked_by_kid ?? vc.expected.kid;
        const key = getKey(trustedKeyset, signerKid);
        expect(key).toBeDefined();
        // ARCHITECTURE.md:286 - Key revocation signer requires key_revoker permission
        expect(canRevokeKey(key!)).toBe(true);
        expect(verifyKeyRevocation(vc.envelope, key!.public_key)).toBe(true);
        expect(
          verifyKeyRevocationWithKeyset(vc.envelope, trustedKeyset, signerKid),
        ).toBe(true);
        if (vc.expected.canonicalPayload) {
          expect(canonicalizeJson(vc.envelope.payload)).toBe(
            vc.expected.canonicalPayload,
          );
        }
        expect(vc.envelope.payload.kid).toBe(vc.expected.revokedKid);
      }

      const report = runKeyRevocationVectors();
      for (const vc of validFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === vc.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe("VALID");
      }
    });

    it("verifies invalid key revocations fail verification with expected reasons", () => {
      const invalidFixtures = readFixtureJson<{
        cases: InvalidKeyRevocationVector[];
      }>("key_revocations/invalid_key_revocations.json");
      expect(invalidFixtures.cases.length).toBe(5);
      const trustedKeyset = loadTrustedKeyset();

      // Check cross-domain key revocation vector mathematically
      const crossDomainKeyRev = invalidFixtures.cases.find(
        (c) => c.id === "key_revocation_cross_domain",
      );
      expect(crossDomainKeyRev).toBeDefined();
      const crossEnvelope = crossDomainKeyRev!
        .envelope as KeyRevocationEnvelope;
      const signerKid =
        crossEnvelope.payload.revoked_by_kid ?? crossEnvelope.payload.kid;
      const crossKey = getKey(trustedKeyset, signerKid);
      expect(crossKey).toBeDefined();
      expect(verifyKeyRevocation(crossEnvelope, crossKey!.public_key)).toBe(
        false,
      );
      expect(
        verifyKeyRevocationWithKeyset(crossEnvelope, trustedKeyset, signerKid),
      ).toBe(false);
      expect(
        verifyEnvelope(
          LEASE_DOMAIN_PREFIX,
          crossEnvelope,
          crossKey!.public_key,
        ),
      ).toBe(true);

      const report = runKeyRevocationVectors();
      for (const ic of invalidFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === ic.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe(ic.expectedFailure);
      }
    });
  });

  describe("Complete Conformance Suite Execution", () => {
    it("executes all golden conformance vectors across all categories with 100% pass rate", () => {
      const suite = runConformanceSuite();
      // 11 keyset + 30 lease (5 valid + 8 tampered payload + 6 tampered sig + 4 cross-domain + 4 expired + 2 future + 1 unknown kid)
      // + 7 revocation (2 valid + 5 invalid) + 7 key revocation (2 valid + 5 invalid) = 55 total checks
      expect(suite.total).toBe(55);
      expect(suite.failed).toBe(0);
      expect(suite.passed).toBe(suite.total);

      for (const result of suite.results) {
        expect(result.passed).toBe(true);
      }
    });
  });
});
