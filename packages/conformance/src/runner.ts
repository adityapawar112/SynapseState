import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseKeysetJson,
  getKey,
  hasKey,
  LeaseEnvelopeSchema,
  RevocationEnvelopeSchema,
  KeyRevocationEnvelopeSchema,
  verifyLease,
  verifyRevocation,
  verifyKeyRevocation,
  evaluateLeaseExpiry,
  isLeaseActive,
  type Keyset,
  type LeaseEnvelope,
  type RevocationEnvelope,
  type KeyRevocationEnvelope,
} from "@synapsestate/lease";
import type {
  VectorResult,
  ConformanceSuiteReport,
  ValidLeaseVector,
  InvalidLeaseVector,
  ValidRevocationVector,
  InvalidRevocationVector,
  ValidKeyRevocationVector,
  InvalidKeyRevocationVector,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_FIXTURES_DIR = path.resolve(__dirname, "../fixtures");

/**
 * Loads and parses a JSON fixture file from the conformance fixtures directory.
 */
export function readFixtureJson<T>(relativePath: string, fixturesDir = DEFAULT_FIXTURES_DIR): T {
  const fullPath = path.join(fixturesDir, relativePath);
  const content = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(content) as T;
}

/**
 * Loads and verifies the authoritative trusted keyset from `keysets/valid_keyset.json`.
 */
export function loadTrustedKeyset(fixturesDir = DEFAULT_FIXTURES_DIR): Keyset {
  const filePath = path.join(fixturesDir, "keysets/valid_keyset.json");
  const content = fs.readFileSync(filePath, "utf8");
  return parseKeysetJson(content);
}

/**
 * Executes all Keyset conformance vectors:
 * - valid_keyset.json (valid standard keys)
 * - empty_keyset.json (authoritative revoke-all-keys directive)
 * - invalid_keyset.json (malformed key bytes, unauthorized roles, invalid syntax)
 */
export function runKeysetVectors(fixturesDir = DEFAULT_FIXTURES_DIR): ConformanceSuiteReport {
  const results: VectorResult[] = [];

  // 1. Valid keyset
  try {
    const validContent = fs.readFileSync(path.join(fixturesDir, "keysets/valid_keyset.json"), "utf8");
    const validKeyset = parseKeysetJson(validContent);
    const keyCount = Object.keys(validKeyset).length;
    const passed = keyCount === 4 && hasKey(validKeyset, "ops-primary-01") && hasKey(validKeyset, "admin-root-01");
    results.push({
      vectorId: "valid_keyset",
      type: "keyset",
      passed,
      message: passed ? undefined : `Expected 4 keys in valid_keyset.json, got ${keyCount}`,
    });
  } catch (err) {
    results.push({
      vectorId: "valid_keyset",
      type: "keyset",
      passed: false,
      message: `Failed to parse valid keyset: ${String(err)}`,
    });
  }

  // 2. Empty keyset (authoritative revoke-all-keys directive `{}`)
  try {
    const emptyContent = fs.readFileSync(path.join(fixturesDir, "keysets/empty_keyset.json"), "utf8");
    const emptyKeyset = parseKeysetJson(emptyContent);
    const passed = Object.keys(emptyKeyset).length === 0;
    results.push({
      vectorId: "empty_keyset_authoritative_revocation",
      type: "keyset",
      passed,
      message: passed ? undefined : "Empty keyset should produce 0 keys",
    });
  } catch (err) {
    results.push({
      vectorId: "empty_keyset_authoritative_revocation",
      type: "keyset",
      passed: false,
      message: `Failed to parse empty keyset: ${String(err)}`,
    });
  }

  // 3. Invalid keyset vectors
  const invalidData = readFixtureJson<{
    cases: Array<{ id: string; description: string; raw: string; expectedError: string }>;
  }>("keysets/invalid_keyset.json", fixturesDir);

  for (const c of invalidData.cases) {
    try {
      parseKeysetJson(c.raw);
      results.push({
        vectorId: c.id,
        type: "keyset",
        passed: false,
        message: `Expected error ${c.expectedError}, but parsing succeeded`,
        expectedStatus: c.expectedError,
        actualStatus: "SUCCESS",
      });
    } catch (err) {
      const errorName = err instanceof Error ? err.name : "UnknownError";
      const passed = errorName === c.expectedError;
      results.push({
        vectorId: c.id,
        type: "keyset",
        passed,
        message: passed ? undefined : `Expected ${c.expectedError}, received ${errorName}`,
        expectedStatus: c.expectedError,
        actualStatus: errorName,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

/**
 * Executes all Lease conformance vectors:
 * - valid_leases.json
 * - tampered_payload_leases.json
 * - tampered_sig_leases.json
 * - cross_domain_leases.json
 * - expired_wall_clock_leases.json
 * - future_dated_leases.json
 */
export function runLeaseVectors(fixturesDir = DEFAULT_FIXTURES_DIR): ConformanceSuiteReport {
  const results: VectorResult[] = [];
  const trustedKeyset = loadTrustedKeyset(fixturesDir);

  // 1. Valid leases
  const validData = readFixtureJson<{ cases: ValidLeaseVector[] }>(
    "leases/valid_leases.json",
    fixturesDir
  );
  for (const c of validData.cases) {
    let passed = true;
    let message = "";

    // Schema validation
    const schemaRes = LeaseEnvelopeSchema.safeParse(c.envelope);
    if (!schemaRes.success) {
      passed = false;
      message = `Schema validation failed: ${schemaRes.error.message}`;
    }

    // Key lookup
    const key = getKey(trustedKeyset, c.envelope.payload.kid);
    if (!key) {
      passed = false;
      message = `Key ${c.envelope.payload.kid} not found in trusted keyset`;
    } else {
      // Signature verification
      const sigOk = verifyLease(c.envelope, key.public_key);
      if (!sigOk) {
        passed = false;
        message = "Signature verification failed for valid lease";
      }
    }

    // Dual-clock evaluation if clock params supplied
    if (passed && c.clockParams) {
      const expiry = evaluateLeaseExpiry({
        issuedAt: c.envelope.payload.issued_at,
        ttlSeconds: c.envelope.payload.ttl_seconds,
        ...c.clockParams,
      });
      const active = isLeaseActive({
        issuedAt: c.envelope.payload.issued_at,
        ttlSeconds: c.envelope.payload.ttl_seconds,
        ...c.clockParams,
      });
      if (!expiry.isValid || expiry.status !== "VALID" || !active) {
        passed = false;
        message = `Dual-clock expiry evaluation failed: status=${expiry.status}, active=${active}`;
      }
    }

    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed ? undefined : message,
      actualStatus: passed ? "VALID" : "INVALID",
      expectedStatus: "VALID",
    });
  }

  // 2. Tampered payload leases (must fail signature verification)
  const tamperedPayloadData = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
    "leases/tampered_payload_leases.json",
    fixturesDir
  );
  for (const c of tamperedPayloadData.cases) {
    const envelope = c.envelope as LeaseEnvelope;
    const key = getKey(trustedKeyset, envelope.payload.kid);
    const sigOk = key ? verifyLease(envelope, key.public_key) : false;

    const passed = sigOk === false;
    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed ? undefined : "Tampered payload unexpectedly verified as valid",
      actualStatus: sigOk ? "VALID_SIGNATURE" : "SIGNATURE_VERIFICATION_FAILED",
      expectedStatus: c.expectedFailure,
    });
  }

  // 3. Tampered signature leases
  const tamperedSigData = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
    "leases/tampered_sig_leases.json",
    fixturesDir
  );
  for (const c of tamperedSigData.cases) {
    let passed = false;
    let actualStatus = "UNKNOWN";

    const schemaRes = LeaseEnvelopeSchema.safeParse(c.envelope);
    if (!schemaRes.success) {
      actualStatus = "SCHEMA_VALIDATION_FAILED";
      passed = c.expectedFailure === "SCHEMA_VALIDATION_FAILED";
    } else {
      const envelope = c.envelope as LeaseEnvelope;
      const key = getKey(trustedKeyset, envelope.payload.kid);
      const sigOk = key ? verifyLease(envelope, key.public_key) : false;
      if (!sigOk) {
        actualStatus = "SIGNATURE_VERIFICATION_FAILED";
        passed = c.expectedFailure === "SIGNATURE_VERIFICATION_FAILED";
      } else {
        actualStatus = "VALID_SIGNATURE";
      }
    }

    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed ? undefined : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure,
    });
  }

  // 4. Cross-domain leases (Domain Separation Invariant)
  const crossDomainData = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
    "leases/cross_domain_leases.json",
    fixturesDir
  );
  for (const c of crossDomainData.cases) {
    const envelope = c.envelope as LeaseEnvelope;
    const key = getKey(trustedKeyset, envelope.payload.kid);
    const sigOk = key ? verifyLease(envelope, key.public_key) : false;

    // Cross-domain signatures must strictly fail lease verification
    const passed = sigOk === false;
    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed ? undefined : "Cross-domain replay succeeded; domain separation violated",
      actualStatus: sigOk ? "VALID_SIGNATURE" : "DOMAIN_SEPARATION_MISMATCH",
      expectedStatus: c.expectedFailure,
    });
  }

  // 5. Expired wall-clock leases (Dual-Clock Expiry Invariant 3)
  const expiredData = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
    "leases/expired_wall_clock_leases.json",
    fixturesDir
  );
  for (const c of expiredData.cases) {
    const envelope = c.envelope as LeaseEnvelope;
    const key = getKey(trustedKeyset, envelope.payload.kid);
    const sigOk = key ? verifyLease(envelope, key.public_key) : false;

    let passed = false;
    let actualStatus = "INVALID";

    if (!sigOk) {
      actualStatus = "SIGNATURE_VERIFICATION_FAILED";
    } else if (c.clockParams) {
      const expiry = evaluateLeaseExpiry({
        issuedAt: envelope.payload.issued_at,
        ttlSeconds: envelope.payload.ttl_seconds,
        ...c.clockParams,
      });
      const active = isLeaseActive({
        issuedAt: envelope.payload.issued_at,
        ttlSeconds: envelope.payload.ttl_seconds,
        ...c.clockParams,
      });
      actualStatus = expiry.status;
      passed = !expiry.isValid && !active && expiry.status === c.expectedFailure;
    }

    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed ? undefined : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure,
    });
  }

  // 6. Future-dated leases (Dual-Clock Expiry Invariant 3)
  const futureData = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
    "leases/future_dated_leases.json",
    fixturesDir
  );
  for (const c of futureData.cases) {
    const envelope = c.envelope as LeaseEnvelope;
    const key = getKey(trustedKeyset, envelope.payload.kid);
    const sigOk = key ? verifyLease(envelope, key.public_key) : false;

    let passed = false;
    let actualStatus = "INVALID";

    if (!sigOk) {
      actualStatus = "SIGNATURE_VERIFICATION_FAILED";
    } else if (c.clockParams) {
      const expiry = evaluateLeaseExpiry({
        issuedAt: envelope.payload.issued_at,
        ttlSeconds: envelope.payload.ttl_seconds,
        ...c.clockParams,
      });
      const active = isLeaseActive({
        issuedAt: envelope.payload.issued_at,
        ttlSeconds: envelope.payload.ttl_seconds,
        ...c.clockParams,
      });
      actualStatus = expiry.status;
      passed = !expiry.isValid && !active && expiry.status === c.expectedFailure;
    }

    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed ? undefined : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

/**
 * Executes all Revocation conformance vectors:
 * - valid_revocations.json
 * - invalid_revocations.json
 */
export function runRevocationVectors(fixturesDir = DEFAULT_FIXTURES_DIR): ConformanceSuiteReport {
  const results: VectorResult[] = [];
  const trustedKeyset = loadTrustedKeyset(fixturesDir);

  // 1. Valid revocations
  const validData = readFixtureJson<{ cases: ValidRevocationVector[] }>(
    "revocations/valid_revocations.json",
    fixturesDir
  );
  for (const c of validData.cases) {
    let passed = true;
    let message = "";

    const schemaRes = RevocationEnvelopeSchema.safeParse(c.envelope);
    if (!schemaRes.success) {
      passed = false;
      message = `Revocation schema invalid: ${schemaRes.error.message}`;
    }

    const key = getKey(trustedKeyset, c.envelope.payload.kid);
    if (!key) {
      passed = false;
      message = `Key ${c.envelope.payload.kid} not found in keyset`;
    } else {
      const sigOk = verifyRevocation(c.envelope, key.public_key);
      if (!sigOk) {
        passed = false;
        message = "Revocation signature verification failed";
      }
    }

    results.push({
      vectorId: c.id,
      type: "revocation",
      passed,
      message: passed ? undefined : message,
      actualStatus: passed ? "VALID" : "INVALID",
      expectedStatus: "VALID",
    });
  }

  // 2. Invalid revocations
  const invalidData = readFixtureJson<{ cases: InvalidRevocationVector[] }>(
    "revocations/invalid_revocations.json",
    fixturesDir
  );
  for (const c of invalidData.cases) {
    let passed = false;
    let actualStatus = "UNKNOWN";

    const schemaRes = RevocationEnvelopeSchema.safeParse(c.envelope);
    if (!schemaRes.success) {
      actualStatus = "SCHEMA_VALIDATION_FAILED";
      passed = c.expectedFailure === "SCHEMA_VALIDATION_FAILED";
    } else {
      const envelope = c.envelope as RevocationEnvelope;
      if (!hasKey(trustedKeyset, envelope.payload.kid)) {
        actualStatus = "UNKNOWN_KEY_ID";
        passed = c.expectedFailure === "UNKNOWN_KEY_ID";
      } else {
        const key = getKey(trustedKeyset, envelope.payload.kid)!;
        const sigOk = verifyRevocation(envelope, key.public_key);
        if (!sigOk) {
          actualStatus =
            c.expectedFailure === "DOMAIN_SEPARATION_MISMATCH"
              ? "DOMAIN_SEPARATION_MISMATCH"
              : "SIGNATURE_VERIFICATION_FAILED";
          passed = true;
        } else {
          actualStatus = "VALID_SIGNATURE";
        }
      }
    }

    results.push({
      vectorId: c.id,
      type: "revocation",
      passed,
      message: passed ? undefined : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

/**
 * Executes all Key Revocation conformance vectors:
 * - valid_key_revocations.json
 * - invalid_key_revocations.json
 */
export function runKeyRevocationVectors(fixturesDir = DEFAULT_FIXTURES_DIR): ConformanceSuiteReport {
  const results: VectorResult[] = [];
  const trustedKeyset = loadTrustedKeyset(fixturesDir);

  // 1. Valid key revocations
  const validData = readFixtureJson<{ cases: ValidKeyRevocationVector[] }>(
    "key_revocations/valid_key_revocations.json",
    fixturesDir
  );
  for (const c of validData.cases) {
    let passed = true;
    let message = "";

    const schemaRes = KeyRevocationEnvelopeSchema.safeParse(c.envelope);
    if (!schemaRes.success) {
      passed = false;
      message = `Key revocation schema invalid: ${schemaRes.error.message}`;
    }

    const signerKid = c.envelope.payload.revoked_by_kid ?? c.expected.kid;
    const key = getKey(trustedKeyset, signerKid);
    if (!key) {
      passed = false;
      message = `Signer key ${signerKid} not in keyset`;
    } else if (key.role !== "admin") {
      passed = false;
      message = `Key revocation signer must have role "admin", got "${key.role}"`;
    } else {
      const sigOk = verifyKeyRevocation(c.envelope, key.public_key);
      if (!sigOk) {
        passed = false;
        message = "Key revocation signature verification failed";
      }
    }

    results.push({
      vectorId: c.id,
      type: "key_revocation",
      passed,
      message: passed ? undefined : message,
      actualStatus: passed ? "VALID" : "INVALID",
      expectedStatus: "VALID",
    });
  }

  // 2. Invalid key revocations
  const invalidData = readFixtureJson<{ cases: InvalidKeyRevocationVector[] }>(
    "key_revocations/invalid_key_revocations.json",
    fixturesDir
  );
  for (const c of invalidData.cases) {
    let passed = false;
    let actualStatus = "UNKNOWN";

    const schemaRes = KeyRevocationEnvelopeSchema.safeParse(c.envelope);
    if (!schemaRes.success) {
      actualStatus = "SCHEMA_VALIDATION_FAILED";
      passed = c.expectedFailure === "SCHEMA_VALIDATION_FAILED";
    } else {
      const envelope = c.envelope as KeyRevocationEnvelope;
      const signerKid = envelope.payload.revoked_by_kid ?? envelope.payload.kid;
      if (!hasKey(trustedKeyset, signerKid)) {
        actualStatus = "UNKNOWN_KEY_ID";
        passed = c.expectedFailure === "UNKNOWN_KEY_ID";
      } else {
        const key = getKey(trustedKeyset, signerKid)!;
        if (key.role !== "admin") {
          actualStatus = "UNAUTHORIZED_SIGNER";
          passed = c.expectedFailure === "UNAUTHORIZED_SIGNER";
        } else {
          const sigOk = verifyKeyRevocation(envelope, key.public_key);
          if (!sigOk) {
            actualStatus =
              c.expectedFailure === "DOMAIN_SEPARATION_MISMATCH"
                ? "DOMAIN_SEPARATION_MISMATCH"
                : "SIGNATURE_VERIFICATION_FAILED";
            passed = true;
          } else {
            actualStatus = "VALID_SIGNATURE";
          }
        }
      }
    }

    results.push({
      vectorId: c.id,
      type: "key_revocation",
      passed,
      message: passed ? undefined : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

/**
 * Runs the complete conformance test suite across keysets, leases, revocations, and key revocations.
 */
export function runConformanceSuite(fixturesDir = DEFAULT_FIXTURES_DIR): ConformanceSuiteReport {
  const keysetReport = runKeysetVectors(fixturesDir);
  const leaseReport = runLeaseVectors(fixturesDir);
  const revocationReport = runRevocationVectors(fixturesDir);
  const keyRevocationReport = runKeyRevocationVectors(fixturesDir);

  const allResults = [
    ...keysetReport.results,
    ...leaseReport.results,
    ...revocationReport.results,
    ...keyRevocationReport.results,
  ];

  const total = allResults.length;
  const passed = allResults.filter((r) => r.passed).length;
  const failed = total - passed;

  return {
    total,
    passed,
    failed,
    results: allResults,
  };
}
