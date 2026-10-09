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
      expect(keyset["admin-root-01"]).toBeDefined();
      expect(keyset["admin-root-01"]?.role).toBe("admin");
    });

    it("verifies empty keyset parses as authoritative 0-key revocation directive", () => {
      const report = runKeysetVectors();
      const emptyResult = report.results.find(
        (r) => r.vectorId === "empty_keyset_authoritative_revocation"
      );
      expect(emptyResult).toBeDefined();
      expect(emptyResult?.passed).toBe(true);
    });

    it("verifies all invalid keyset test vectors fail parsing or validation as expected", () => {
      const report = runKeysetVectors();
      expect(report.total).toBe(11); // valid + empty + 9 invalid cases
      expect(report.failed).toBe(0);
      expect(report.passed).toBe(11);
    });
  });

  describe("Emergency Lease Vectors (fixtures/leases/)", () => {
    it("verifies 100% of valid leases pass envelope, signature, and dual-clock validation", () => {
      const validFixtures = readFixtureJson<{ cases: ValidLeaseVector[] }>(
        "leases/valid_leases.json"
      );
      expect(validFixtures.cases.length).toBe(5);

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
        "leases/tampered_payload_leases.json"
      );
      expect(tamperedFixtures.cases.length).toBe(7);

      const report = runLeaseVectors();
      for (const tc of tamperedFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === tc.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe("SIGNATURE_VERIFICATION_FAILED");
      }
    });

    it("verifies tampered signature leases fail schema validation or cryptographic verification", () => {
      const tamperedSigFixtures = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
        "leases/tampered_sig_leases.json"
      );
      expect(tamperedSigFixtures.cases.length).toBe(5);

      const report = runLeaseVectors();
      for (const tc of tamperedSigFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === tc.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
      }
    });

    it("enforces Domain Separation Invariant: cross-domain signed leases fail verification", () => {
      const crossDomainFixtures = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
        "leases/cross_domain_leases.json"
      );
      expect(crossDomainFixtures.cases.length).toBe(4);

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
        "leases/expired_wall_clock_leases.json"
      );
      expect(expiredFixtures.cases.length).toBe(4);

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
        "leases/future_dated_leases.json"
      );
      expect(futureFixtures.cases.length).toBe(2);

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
        "revocations/valid_revocations.json"
      );
      expect(validFixtures.cases.length).toBe(2);

      const report = runRevocationVectors();
      for (const vc of validFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === vc.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe("VALID");
      }
    });

    it("verifies invalid lease revocations fail verification with expected reasons", () => {
      const invalidFixtures = readFixtureJson<{ cases: InvalidRevocationVector[] }>(
        "revocations/invalid_revocations.json"
      );
      expect(invalidFixtures.cases.length).toBe(5);

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
      const validFixtures = readFixtureJson<{ cases: ValidKeyRevocationVector[] }>(
        "key_revocations/valid_key_revocations.json"
      );
      expect(validFixtures.cases.length).toBe(2);

      const report = runKeyRevocationVectors();
      for (const vc of validFixtures.cases) {
        const result = report.results.find((r) => r.vectorId === vc.id);
        expect(result).toBeDefined();
        expect(result?.passed).toBe(true);
        expect(result?.actualStatus).toBe("VALID");
      }
    });

    it("verifies invalid key revocations fail verification with expected reasons", () => {
      const invalidFixtures = readFixtureJson<{ cases: InvalidKeyRevocationVector[] }>(
        "key_revocations/invalid_key_revocations.json"
      );
      expect(invalidFixtures.cases.length).toBe(5);

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
      expect(suite.total).toBe(52); // 11 keyset + 27 lease + 7 revocation + 7 key revocation = 52 total checks
      expect(suite.failed).toBe(0);
      expect(suite.passed).toBe(suite.total);

      for (const result of suite.results) {
        expect(result.passed).toBe(true);
      }
    });
  });
});
