import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseKeysetJson,
  getKey,
  hasKey,
  canRevokeLease,
  canRevokeKey,
  verifyLeaseWithKeyset,
  verifyRevocationWithKeyset,
  verifyKeyRevocationWithKeyset,
  resolvePublicKey,
  LEASE_DOMAIN_PREFIX,
  REVOCATION_DOMAIN_PREFIX,
  KEYREVOCATION_DOMAIN_PREFIX,
  verifyEnvelope,
  LeaseEnvelopeSchema,
  RevocationEnvelopeSchema,
  KeyRevocationEnvelopeSchema,
  evaluateLeaseExpiry,
  isLeaseActive,
  type Keyset,
  type LeaseEnvelope,
  type RevocationEnvelope,
  type KeyRevocationEnvelope,
} from "@synapsestate/lease";
import type {
  VectorResult,
  VectorStatusCode,
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
export function readFixtureJson<T>(
  relativePath: string,
  fixturesDir = DEFAULT_FIXTURES_DIR,
): T {
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
export function runKeysetVectors(
  fixturesDir = DEFAULT_FIXTURES_DIR,
): ConformanceSuiteReport {
  const results: VectorResult[] = [];

  // 1. Valid keyset
  try {
    const validContent = fs.readFileSync(
      path.join(fixturesDir, "keysets/valid_keyset.json"),
      "utf8",
    );
    const validKeyset = parseKeysetJson(validContent);
    const keyCount = Object.keys(validKeyset).length;

    // Deep verification: assert all expected keys, roles, TTLs, and cryptographic resolutions
    const hasAllKeys =
      keyCount === 4 &&
      hasKey(validKeyset, "ops-primary-01") &&
      hasKey(validKeyset, "ops-secondary-02") &&
      hasKey(validKeyset, "admin-root-01") &&
      hasKey(validKeyset, "admin-backup-02");

    const rolesCorrect =
      validKeyset["ops-primary-01"]?.role === "operator" &&
      validKeyset["ops-primary-01"]?.max_ttl_seconds === 3600 &&
      validKeyset["ops-secondary-02"]?.role === "operator" &&
      validKeyset["ops-secondary-02"]?.max_ttl_seconds === 7200 &&
      validKeyset["admin-root-01"]?.role === "admin" &&
      validKeyset["admin-backup-02"]?.role === "admin";

    let cryptoResolved = true;
    for (const entry of Object.values(validKeyset)) {
      try {
        resolvePublicKey(entry.public_key);
      } catch {
        cryptoResolved = false;
      }
    }

    const passed = hasAllKeys && rolesCorrect && cryptoResolved;
    results.push({
      vectorId: "valid_keyset",
      type: "keyset",
      passed,
      message: passed
        ? undefined
        : "Valid keyset failed deep property validation",
      actualStatus: passed ? "VALID" : "INVALID",
      expectedStatus: "VALID",
    });
  } catch (err) {
    results.push({
      vectorId: "valid_keyset",
      type: "keyset",
      passed: false,
      message: `Failed to parse valid keyset: ${String(err)}`,
      actualStatus: "INVALID",
      expectedStatus: "VALID",
    });
  }

  // 2. Empty keyset (authoritative revoke-all-keys directive `{}`)
  try {
    const emptyContent = fs.readFileSync(
      path.join(fixturesDir, "keysets/empty_keyset.json"),
      "utf8",
    );
    const emptyKeyset = parseKeysetJson(emptyContent);
    const passed = Object.keys(emptyKeyset).length === 0;
    results.push({
      vectorId: "empty_keyset_authoritative_revocation",
      type: "keyset",
      passed,
      message: passed ? undefined : "Empty keyset should produce 0 keys",
      actualStatus: passed ? "VALID_EMPTY" : "INVALID",
      expectedStatus: "VALID_EMPTY",
    });
  } catch (err) {
    results.push({
      vectorId: "empty_keyset_authoritative_revocation",
      type: "keyset",
      passed: false,
      message: `Failed to parse empty keyset: ${String(err)}`,
      actualStatus: "INVALID",
      expectedStatus: "VALID_EMPTY",
    });
  }

  // 3. Invalid keyset vectors
  const invalidData = readFixtureJson<{
    cases: Array<{
      id: string;
      description: string;
      raw: string;
      expectedError: string;
    }>;
  }>("keysets/invalid_keyset.json", fixturesDir);

  for (const c of invalidData.cases) {
    try {
      parseKeysetJson(c.raw);
      results.push({
        vectorId: c.id,
        type: "keyset",
        passed: false,
        message: `Expected error ${c.expectedError}, but parsing succeeded`,
        expectedStatus: c.expectedError as VectorStatusCode,
        actualStatus: "VALID",
      });
    } catch (err) {
      const errorName = err instanceof Error ? err.name : "UnknownError";
      const hasMessage = err instanceof Error && err.message.length > 0;
      const passed = errorName === c.expectedError && hasMessage;
      results.push({
        vectorId: c.id,
        type: "keyset",
        passed,
        message: passed
          ? undefined
          : `Expected ${c.expectedError}, received ${errorName}`,
        expectedStatus: c.expectedError as VectorStatusCode,
        actualStatus: errorName as VectorStatusCode,
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
 * - unknown_kid_leases.json
 */
export function runLeaseVectors(
  fixturesDir = DEFAULT_FIXTURES_DIR,
): ConformanceSuiteReport {
  const results: VectorResult[] = [];
  const trustedKeyset = loadTrustedKeyset(fixturesDir);

  // 1. Valid leases (enforcing authoritative keyset-policy seam)
  const validData = readFixtureJson<{ cases: ValidLeaseVector[] }>(
    "leases/valid_leases.json",
    fixturesDir,
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

    // Verify semantic payload matches expected test vector assertions
    if (c.envelope.payload.flag_key !== c.expected.flagKey) {
      passed = false;
      message = `Expected flag_key "${c.expected.flagKey}", got "${c.envelope.payload.flag_key}"`;
    }
    if (
      JSON.stringify(c.envelope.payload.value) !==
      JSON.stringify(c.expected.resolvedValue)
    ) {
      passed = false;
      message = `Expected resolvedValue ${JSON.stringify(c.expected.resolvedValue)}, got ${JSON.stringify(c.envelope.payload.value)}`;
    }
    if (c.envelope.payload.kid !== c.expected.kid) {
      passed = false;
      message = `Expected kid "${c.expected.kid}", got "${c.envelope.payload.kid}"`;
    }

    // Authoritative Keyset-Policy Seam Verification
    // Enforces: kid exists in keyset, active key status, lease_signer role, max_ttl_seconds ceiling, Ed25519 signature
    const keysetValid = verifyLeaseWithKeyset(c.envelope, trustedKeyset);
    if (!keysetValid) {
      passed = false;
      message = "Authoritative verifyLeaseWithKeyset failed for valid lease";
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
      if (
        !expiry.isValid ||
        expiry.status !== "VALID" ||
        expiry.remainingEffectiveMs <= 0 ||
        !active
      ) {
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

  // 2. Tampered payload leases (must fail signature verification via keyset seam)
  const tamperedPayloadData = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
    "leases/tampered_payload_leases.json",
    fixturesDir,
  );
  for (const c of tamperedPayloadData.cases) {
    const envelope = c.envelope as LeaseEnvelope;
    // Check precondition: key MUST exist in trusted keyset (ensures failure is purely cryptographic tamper)
    const key = getKey(trustedKeyset, envelope.payload.kid);
    const schemaOk = LeaseEnvelopeSchema.safeParse(envelope).success;

    let passed = false;
    let actualStatus: VectorStatusCode = "UNKNOWN";

    if (!key) {
      actualStatus = "KEY_NOT_FOUND_PRECONDITION_FAILED";
    } else if (!schemaOk) {
      actualStatus = "SCHEMA_FAILED_PRECONDITION_FAILED";
    } else {
      const sigOk = verifyLeaseWithKeyset(envelope, trustedKeyset);
      if (!sigOk) {
        actualStatus = "SIGNATURE_INVALID";
        passed =
          c.expectedFailure === "SIGNATURE_INVALID" ||
          (c.expectedFailure as string) === "SIGNATURE_VERIFICATION_FAILED";
      } else {
        actualStatus = "VALID_SIGNATURE";
      }
    }

    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed
        ? undefined
        : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure as VectorStatusCode,
    });
  }

  // 3. Tampered signature leases
  const tamperedSigData = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
    "leases/tampered_sig_leases.json",
    fixturesDir,
  );
  for (const c of tamperedSigData.cases) {
    let passed = false;
    let actualStatus: VectorStatusCode = "UNKNOWN";

    const schemaRes = LeaseEnvelopeSchema.safeParse(c.envelope);
    if (!schemaRes.success) {
      actualStatus = "SCHEMA_VALIDATION_FAILED";
      passed = c.expectedFailure === "SCHEMA_VALIDATION_FAILED";
    } else {
      const envelope = c.envelope as LeaseEnvelope;
      const key = getKey(trustedKeyset, envelope.payload.kid);
      if (!key) {
        actualStatus = "KEY_NOT_FOUND_PRECONDITION_FAILED";
      } else {
        const sigOk = verifyLeaseWithKeyset(envelope, trustedKeyset);
        if (!sigOk) {
          actualStatus = "SIGNATURE_INVALID";
          passed =
            c.expectedFailure === "SIGNATURE_INVALID" ||
            (c.expectedFailure as string) === "SIGNATURE_VERIFICATION_FAILED";
        } else {
          actualStatus = "VALID_SIGNATURE";
        }
      }
    }

    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed
        ? undefined
        : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure as VectorStatusCode,
    });
  }

  // 4. Cross-domain leases (Domain Separation Invariant)
  const crossDomainData = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
    "leases/cross_domain_leases.json",
    fixturesDir,
  );
  for (const c of crossDomainData.cases) {
    const envelope = c.envelope as LeaseEnvelope;
    const key = getKey(trustedKeyset, envelope.payload.kid);
    const schemaOk = LeaseEnvelopeSchema.safeParse(envelope).success;

    let passed = false;
    let actualStatus: VectorStatusCode = "UNKNOWN";

    if (!key) {
      actualStatus = "KEY_NOT_FOUND_PRECONDITION_FAILED";
    } else if (!schemaOk) {
      actualStatus = "SCHEMA_FAILED_PRECONDITION_FAILED";
    } else {
      const leaseSigOk = verifyLeaseWithKeyset(envelope, trustedKeyset);

      // Cryptographic verification: Prove that the signature IS mathematically valid under its original domain,
      // and rejected strictly by LEASE_DOMAIN_PREFIX separation.
      let domainAuthentic = false;
      if (c.id === "cross_domain_signed_with_revocation_prefix") {
        domainAuthentic = verifyEnvelope(
          REVOCATION_DOMAIN_PREFIX,
          envelope,
          key.public_key,
        );
      } else if (c.id === "cross_domain_signed_with_keyrevocation_prefix") {
        domainAuthentic = verifyEnvelope(
          KEYREVOCATION_DOMAIN_PREFIX,
          envelope,
          key.public_key,
        );
      } else if (c.id === "cross_domain_signed_with_bogus_prefix") {
        domainAuthentic = verifyEnvelope(
          "synapsestate/audit/v1\n",
          envelope,
          key.public_key,
        );
      } else if (c.id === "cross_domain_signed_with_empty_prefix") {
        domainAuthentic = verifyEnvelope("", envelope, key.public_key);
      }

      if (!leaseSigOk && domainAuthentic) {
        actualStatus = "DOMAIN_SEPARATION_MISMATCH";
        passed = true;
      } else if (leaseSigOk) {
        actualStatus = "VALID_SIGNATURE";
      } else {
        actualStatus = "SIGNATURE_INVALID_UNDER_BOTH_DOMAINS";
      }
    }

    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed
        ? undefined
        : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure as VectorStatusCode,
    });
  }

  // 5. Expired wall-clock leases (Dual-Clock Expiry Invariant 3)
  const expiredData = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
    "leases/expired_wall_clock_leases.json",
    fixturesDir,
  );
  for (const c of expiredData.cases) {
    const envelope = c.envelope as LeaseEnvelope;
    const key = getKey(trustedKeyset, envelope.payload.kid);
    const sigOk = key ? verifyLeaseWithKeyset(envelope, trustedKeyset) : false;

    let passed = false;
    let actualStatus: VectorStatusCode = "INVALID";

    if (!key) {
      actualStatus = "KEY_NOT_FOUND_PRECONDITION_FAILED";
    } else if (!sigOk) {
      actualStatus = "SIGNATURE_INVALID";
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
      actualStatus = expiry.status as VectorStatusCode;
      passed =
        !expiry.isValid &&
        !active &&
        expiry.remainingEffectiveMs === 0 &&
        expiry.status === c.expectedFailure;
    }

    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed
        ? undefined
        : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure as VectorStatusCode,
    });
  }

  // 6. Future-dated leases (Dual-Clock Expiry Invariant 3)
  const futureData = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
    "leases/future_dated_leases.json",
    fixturesDir,
  );
  for (const c of futureData.cases) {
    const envelope = c.envelope as LeaseEnvelope;
    const key = getKey(trustedKeyset, envelope.payload.kid);
    const sigOk = key ? verifyLeaseWithKeyset(envelope, trustedKeyset) : false;

    let passed = false;
    let actualStatus: VectorStatusCode = "INVALID";

    if (!key) {
      actualStatus = "KEY_NOT_FOUND_PRECONDITION_FAILED";
    } else if (!sigOk) {
      actualStatus = "SIGNATURE_INVALID";
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
      actualStatus = expiry.status as VectorStatusCode;
      passed =
        !expiry.isValid &&
        !active &&
        expiry.remainingEffectiveMs === 0 &&
        expiry.status === c.expectedFailure;
    }

    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed
        ? undefined
        : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure as VectorStatusCode,
    });
  }

  // 7. Unknown Kid leases (Keyset Policy Seam)
  const unknownKidData = readFixtureJson<{ cases: InvalidLeaseVector[] }>(
    "leases/unknown_kid_leases.json",
    fixturesDir,
  );
  for (const c of unknownKidData.cases) {
    const envelope = c.envelope as LeaseEnvelope;
    const schemaRes = LeaseEnvelopeSchema.safeParse(envelope);

    let passed = false;
    let actualStatus: VectorStatusCode = "UNKNOWN";

    if (!schemaRes.success) {
      actualStatus = "SCHEMA_VALIDATION_FAILED";
    } else if (!hasKey(trustedKeyset, envelope.payload.kid)) {
      actualStatus = "UNKNOWN_KEY";
      // Authoritative seam must fail
      const keysetValid = verifyLeaseWithKeyset(envelope, trustedKeyset);
      passed =
        (c.expectedFailure === "UNKNOWN_KEY" ||
          (c.expectedFailure as string) === "UNKNOWN_KEY_ID") &&
        !keysetValid;
    } else {
      actualStatus = "VALID_SIGNATURE";
    }

    results.push({
      vectorId: c.id,
      type: "lease",
      passed,
      message: passed
        ? undefined
        : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure as VectorStatusCode,
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
export function runRevocationVectors(
  fixturesDir = DEFAULT_FIXTURES_DIR,
): ConformanceSuiteReport {
  const results: VectorResult[] = [];
  const trustedKeyset = loadTrustedKeyset(fixturesDir);

  // 1. Valid revocations (enforcing authoritative keyset-policy seam)
  const validData = readFixtureJson<{ cases: ValidRevocationVector[] }>(
    "revocations/valid_revocations.json",
    fixturesDir,
  );
  for (const c of validData.cases) {
    let passed = true;
    let message = "";

    const schemaRes = RevocationEnvelopeSchema.safeParse(c.envelope);
    if (!schemaRes.success) {
      passed = false;
      message = `Revocation schema invalid: ${schemaRes.error.message}`;
    }

    if (c.envelope.payload.lease_id !== c.expected.leaseId) {
      passed = false;
      message = `Expected leaseId "${c.expected.leaseId}", got "${c.envelope.payload.lease_id}"`;
    }
    if (c.envelope.payload.kid !== c.expected.kid) {
      passed = false;
      message = `Expected kid "${c.expected.kid}", got "${c.envelope.payload.kid}"`;
    }

    // Authoritative Keyset-Policy Seam: verifyRevocationWithKeyset
    // Enforces: kid in keyset, active key status, lease_signer role, Ed25519 signature
    const revOk = verifyRevocationWithKeyset(c.envelope, trustedKeyset);
    if (!revOk) {
      passed = false;
      message =
        "Authoritative verifyRevocationWithKeyset failed for valid revocation";
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
    fixturesDir,
  );
  for (const c of invalidData.cases) {
    let passed = false;
    let actualStatus: VectorStatusCode = "UNKNOWN";

    const schemaRes = RevocationEnvelopeSchema.safeParse(c.envelope);
    if (!schemaRes.success) {
      actualStatus = "SCHEMA_VALIDATION_FAILED";
      passed = c.expectedFailure === "SCHEMA_VALIDATION_FAILED";
    } else {
      const envelope = c.envelope as RevocationEnvelope;
      if (!hasKey(trustedKeyset, envelope.payload.kid)) {
        actualStatus = "UNKNOWN_KEY";
        passed =
          c.expectedFailure === "UNKNOWN_KEY" ||
          (c.expectedFailure as string) === "UNKNOWN_KEY_ID";
      } else {
        const key = getKey(trustedKeyset, envelope.payload.kid)!;
        if (!canRevokeLease(key)) {
          actualStatus = "UNAUTHORIZED_SIGNER";
          passed = c.expectedFailure === "UNAUTHORIZED_SIGNER";
        } else {
          const revOk = verifyRevocationWithKeyset(envelope, trustedKeyset);
          if (!revOk) {
            // Cryptographic domain proof check for cross-domain case
            if (c.id === "revocation_cross_domain_lease_prefix") {
              const authenticUnderLeasePrefix = verifyEnvelope(
                LEASE_DOMAIN_PREFIX,
                envelope,
                key.public_key,
              );
              actualStatus = authenticUnderLeasePrefix
                ? "DOMAIN_SEPARATION_MISMATCH"
                : "SIGNATURE_CORRUPTED";
              passed =
                c.expectedFailure === "DOMAIN_SEPARATION_MISMATCH" &&
                authenticUnderLeasePrefix;
            } else {
              actualStatus = "SIGNATURE_INVALID";
              passed =
                c.expectedFailure === "SIGNATURE_INVALID" ||
                (c.expectedFailure as string) ===
                  "SIGNATURE_VERIFICATION_FAILED";
            }
          } else {
            actualStatus = "VALID_SIGNATURE";
          }
        }
      }
    }

    results.push({
      vectorId: c.id,
      type: "revocation",
      passed,
      message: passed
        ? undefined
        : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure as VectorStatusCode,
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
export function runKeyRevocationVectors(
  fixturesDir = DEFAULT_FIXTURES_DIR,
): ConformanceSuiteReport {
  const results: VectorResult[] = [];
  const trustedKeyset = loadTrustedKeyset(fixturesDir);

  // 1. Valid key revocations (enforcing authoritative keyset-policy seam & key_revoker role)
  const validData = readFixtureJson<{ cases: ValidKeyRevocationVector[] }>(
    "key_revocations/valid_key_revocations.json",
    fixturesDir,
  );
  for (const c of validData.cases) {
    let passed = true;
    let message = "";

    const schemaRes = KeyRevocationEnvelopeSchema.safeParse(c.envelope);
    if (!schemaRes.success) {
      passed = false;
      message = `Key revocation schema invalid: ${schemaRes.error.message}`;
    }

    if (c.envelope.payload.kid !== c.expected.revokedKid) {
      passed = false;
      message = `Expected revokedKid "${c.expected.revokedKid}", got "${c.envelope.payload.kid}"`;
    }

    const signerKid = c.envelope.payload.revoked_by_kid ?? c.expected.kid;
    if (signerKid !== c.expected.kid) {
      passed = false;
      message = `Expected signer kid "${c.expected.kid}", got "${signerKid}"`;
    }

    // Authoritative Keyset-Policy Seam: verifyKeyRevocationWithKeyset (ARCHITECTURE.md:286)
    // Enforces: revoked_by_kid in keyset, active key status, canRevokeKey (requires key_revoker role), Ed25519 signature
    const keyRevOk = verifyKeyRevocationWithKeyset(
      c.envelope,
      trustedKeyset,
      signerKid,
    );
    if (!keyRevOk) {
      passed = false;
      message =
        "Authoritative verifyKeyRevocationWithKeyset failed for valid key revocation";
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
    fixturesDir,
  );
  for (const c of invalidData.cases) {
    let passed = false;
    let actualStatus: VectorStatusCode = "UNKNOWN";

    const schemaRes = KeyRevocationEnvelopeSchema.safeParse(c.envelope);
    if (!schemaRes.success) {
      actualStatus = "SCHEMA_VALIDATION_FAILED";
      passed = c.expectedFailure === "SCHEMA_VALIDATION_FAILED";
    } else {
      const envelope = c.envelope as KeyRevocationEnvelope;
      const signerKid = envelope.payload.revoked_by_kid ?? envelope.payload.kid;
      if (!hasKey(trustedKeyset, signerKid)) {
        actualStatus = "UNKNOWN_KEY";
        passed =
          c.expectedFailure === "UNKNOWN_KEY" ||
          (c.expectedFailure as string) === "UNKNOWN_KEY_ID";
      } else {
        const key = getKey(trustedKeyset, signerKid)!;
        // Check architectural key revocation permission (canRevokeKey per ARCHITECTURE.md:286)
        if (!canRevokeKey(key)) {
          actualStatus = "UNAUTHORIZED_SIGNER";
          passed = c.expectedFailure === "UNAUTHORIZED_SIGNER";
        } else {
          const sigOk = verifyKeyRevocationWithKeyset(
            envelope,
            trustedKeyset,
            signerKid,
          );
          if (!sigOk) {
            if (c.id === "key_revocation_cross_domain") {
              const authenticUnderLeasePrefix = verifyEnvelope(
                LEASE_DOMAIN_PREFIX,
                envelope,
                key.public_key,
              );
              actualStatus = authenticUnderLeasePrefix
                ? "DOMAIN_SEPARATION_MISMATCH"
                : "SIGNATURE_CORRUPTED";
              passed =
                c.expectedFailure === "DOMAIN_SEPARATION_MISMATCH" &&
                authenticUnderLeasePrefix;
            } else {
              actualStatus = "SIGNATURE_INVALID";
              passed =
                c.expectedFailure === "SIGNATURE_INVALID" ||
                (c.expectedFailure as string) ===
                  "SIGNATURE_VERIFICATION_FAILED";
            }
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
      message: passed
        ? undefined
        : `Expected ${c.expectedFailure}, got ${actualStatus}`,
      actualStatus,
      expectedStatus: c.expectedFailure as VectorStatusCode,
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
export function runConformanceSuite(
  fixturesDir = DEFAULT_FIXTURES_DIR,
): ConformanceSuiteReport {
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
