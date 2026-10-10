import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEASE_DOMAIN_PREFIX,
  REVOCATION_DOMAIN_PREFIX,
  KEYREVOCATION_DOMAIN_PREFIX,
  canonicalizeJson,
  signEnvelope,
  signLease,
  signRevocation,
  signKeyRevocation,
  type LeasePayload,
  type RevocationPayload,
  type KeyRevocationPayload,
  type Keyset,
} from "@synapsestate/lease";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");

// Helper to deterministically derive Ed25519 keypair from a constant string seed
function deriveDeterministicKeyPair(seedStr: string) {
  const seed = crypto.createHash("sha256").update(seedStr).digest();
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  const privateKey = crypto.createPrivateKey({
    key: pkcs8,
    format: "der",
    type: "pkcs8",
  });
  const publicKey = crypto.createPublicKey(privateKey);
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(12);

  return {
    privateKey,
    publicKey,
    publicKeyBase64Url: rawPub.toString("base64url"),
    publicKeyHex: rawPub.toString("hex"),
  };
}

// Stable test keys
const KEYS = {
  ops1: {
    kid: "ops-primary-01",
    role: "operator" as const,
    maxTtlSeconds: 3600,
    ...deriveDeterministicKeyPair("synapsestate:test:ops-1"),
  },
  ops2: {
    kid: "ops-secondary-02",
    role: "operator" as const,
    maxTtlSeconds: 7200,
    ...deriveDeterministicKeyPair("synapsestate:test:ops-2"),
  },
  admin1: {
    kid: "admin-root-01",
    role: "admin" as const,
    maxTtlSeconds: undefined,
    ...deriveDeterministicKeyPair("synapsestate:test:admin-1"),
  },
  admin2: {
    kid: "admin-backup-02",
    role: "admin" as const,
    maxTtlSeconds: undefined,
    ...deriveDeterministicKeyPair("synapsestate:test:admin-2"),
  },
  rogue: {
    kid: "untrusted-rogue-01",
    role: "operator" as const,
    maxTtlSeconds: 3600,
    ...deriveDeterministicKeyPair("synapsestate:test:untrusted-rogue-01"),
  },
};

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeJson(filePath: string, data: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function generateAllFixtures() {
  console.log(`Generating golden conformance fixtures in ${FIXTURES_DIR}...`);

  // ==========================================
  // 1. KEYSETS (fixtures/keysets/)
  // ==========================================
  const validKeyset: Keyset = {
    [KEYS.ops1.kid]: {
      public_key: KEYS.ops1.publicKeyBase64Url,
      role: KEYS.ops1.role,
      max_ttl_seconds: KEYS.ops1.maxTtlSeconds,
    },
    [KEYS.ops2.kid]: {
      public_key: KEYS.ops2.publicKeyBase64Url,
      role: KEYS.ops2.role,
      max_ttl_seconds: KEYS.ops2.maxTtlSeconds,
    },
    [KEYS.admin1.kid]: {
      public_key: KEYS.admin1.publicKeyBase64Url,
      role: KEYS.admin1.role,
    },
    [KEYS.admin2.kid]: {
      public_key: KEYS.admin2.publicKeyBase64Url,
      role: KEYS.admin2.role,
    },
  };

  writeJson(path.join(FIXTURES_DIR, "keysets/valid_keyset.json"), validKeyset);
  writeJson(path.join(FIXTURES_DIR, "keysets/empty_keyset.json"), {});

  const invalidKeysetCases = {
    description: "Invalid keyset test vectors that must fail parsing or validation",
    cases: [
      {
        id: "keyset_invalid_role",
        description: "Keyset entry contains unauthorized role 'superuser'",
        raw: JSON.stringify({
          "ops-1": {
            public_key: KEYS.ops1.publicKeyBase64Url,
            role: "superuser",
          },
        }),
        expectedError: "KeysetValidationError",
      },
      {
        id: "keyset_malformed_key_bytes",
        description: "Keyset entry public_key contains invalid characters",
        raw: JSON.stringify({
          "ops-1": {
            public_key: "not-a-valid-key!!@@##$$",
            role: "operator",
          },
        }),
        expectedError: "KeysetValidationError",
      },
      {
        id: "keyset_wrong_length_public_key",
        description: "Keyset entry public_key is 16 bytes instead of 32 bytes",
        raw: JSON.stringify({
          "ops-1": {
            public_key: Buffer.from("0123456789abcdef").toString("base64url"),
            role: "operator",
          },
        }),
        expectedError: "KeysetValidationError",
      },
      {
        id: "keyset_negative_max_ttl",
        description: "Keyset entry max_ttl_seconds is negative",
        raw: JSON.stringify({
          "ops-1": {
            public_key: KEYS.ops1.publicKeyBase64Url,
            role: "operator",
            max_ttl_seconds: -100,
          },
        }),
        expectedError: "KeysetValidationError",
      },
      {
        id: "keyset_excessive_max_ttl",
        description: "Keyset entry max_ttl_seconds exceeds 86400 (24h)",
        raw: JSON.stringify({
          "ops-1": {
            public_key: KEYS.ops1.publicKeyBase64Url,
            role: "operator",
            max_ttl_seconds: 90000,
          },
        }),
        expectedError: "KeysetValidationError",
      },
      {
        id: "keyset_empty_kid",
        description: "Keyset entry has empty string kid key",
        raw: JSON.stringify({
          "": {
            public_key: KEYS.ops1.publicKeyBase64Url,
            role: "operator",
          },
        }),
        expectedError: "KeysetValidationError",
      },
      {
        id: "keyset_malformed_json_syntax",
        description: "Keyset content is syntactically invalid JSON",
        raw: "{\n  \"ops-1\": { unquoted_key: true \n}",
        expectedError: "KeysetParseError",
      },
      {
        id: "keyset_whitespace_only",
        description: "Keyset content is empty whitespace string",
        raw: "   \n\t  \r\n  ",
        expectedError: "KeysetParseError",
      },
      {
        id: "keyset_array_root",
        description: "Keyset root is a JSON array instead of dictionary object",
        raw: JSON.stringify([
          {
            kid: "ops-1",
            public_key: KEYS.ops1.publicKeyBase64Url,
            role: "operator",
          },
        ]),
        expectedError: "KeysetValidationError",
      },
    ],
  };

  writeJson(path.join(FIXTURES_DIR, "keysets/invalid_keyset.json"), invalidKeysetCases);

  // ==========================================
  // 2. LEASES (fixtures/leases/)
  // ==========================================
  const baseTimestampMs = Date.parse("2026-10-09T12:00:00.000Z");
  const baseIso = "2026-10-09T12:00:00.000Z";

  // 2.1 Valid Leases
  const validPayload1: LeasePayload = {
    v: 1,
    lease_id: "01J9X000000000000000000001",
    env: "production",
    flag_key: "killswitch-payment-v2",
    value: true,
    reason: "INC-991: Payment provider latency spike mitigation",
    issued_at: baseIso,
    ttl_seconds: 1800,
    kid: KEYS.ops1.kid,
    nonce: "nonce-random-val-001",
  };
  const validEnvelope1 = signLease(validPayload1, KEYS.ops1.privateKey);

  const validPayload2: LeasePayload = {
    v: 1,
    lease_id: "01J9X000000000000000000002",
    env: "production",
    flag_key: "ui-theme-variant",
    value: "high-contrast-dark",
    reason: "INC-992: Accessibility incident hotfix",
    issued_at: baseIso,
    ttl_seconds: 3600,
    kid: KEYS.ops2.kid,
    nonce: "nonce-random-val-002",
  };
  const validEnvelope2 = signLease(validPayload2, KEYS.ops2.privateKey);

  const validPayload3: LeasePayload = {
    v: 1,
    lease_id: "01J9X000000000000000000003",
    env: "production",
    flag_key: "rate-limit-requests-per-min",
    value: 500,
    reason: "INC-993: Abuse traffic throttle override",
    issued_at: baseIso,
    ttl_seconds: 600,
    kid: KEYS.ops1.kid,
    nonce: "nonce-random-val-003",
  };
  const validEnvelope3 = signLease(validPayload3, KEYS.ops1.privateKey);

  const validPayload4: LeasePayload = {
    v: 1,
    lease_id: "01J9X000000000000000000004",
    env: "production",
    flag_key: "tracing-config-dynamic",
    value: { sample_rate: 0.25, datacenter: "us-east-1" },
    reason: "INC-994: High ingestion load debug tracing",
    issued_at: baseIso,
    ttl_seconds: 1200,
    kid: KEYS.admin1.kid,
    nonce: "nonce-random-val-004",
  };
  const validEnvelope4 = signLease(validPayload4, KEYS.admin1.privateKey);

  const validPayload5: LeasePayload = {
    v: 1,
    lease_id: "01J9X000000000000000000005",
    env: "production",
    flag_key: "allowed-user-tiers",
    value: ["admin", "beta-tester", "internal"],
    reason: "INC-995: Beta rollout gating bypass",
    issued_at: baseIso,
    ttl_seconds: 900,
    kid: KEYS.admin2.kid,
    nonce: "nonce-random-val-005",
  };
  const validEnvelope5 = signLease(validPayload5, KEYS.admin2.privateKey);

  const validLeases = {
    description: "Valid signed emergency lease envelopes with expected flag evaluation details",
    cases: [
      {
        id: "valid_lease_boolean_flag",
        description: "Valid boolean flag override signed by operator",
        type: "lease",
        valid: true,
        envelope: validEnvelope1,
        expected: {
          flagKey: "killswitch-payment-v2",
          resolvedValue: true,
          reason: "OVERRIDE",
          kid: KEYS.ops1.kid,
          canonicalPayload: canonicalizeJson(validPayload1),
        },
        clockParams: {
          nowWallMs: baseTimestampMs + 300_000, // 5 min into 30 min lease
          nowMonoMs: 300_000,
          firstSeenMonoMs: 0,
          skewToleranceMs: 30_000,
        },
      },
      {
        id: "valid_lease_string_flag",
        description: "Valid string variant override signed by secondary operator",
        type: "lease",
        valid: true,
        envelope: validEnvelope2,
        expected: {
          flagKey: "ui-theme-variant",
          resolvedValue: "high-contrast-dark",
          reason: "OVERRIDE",
          kid: KEYS.ops2.kid,
          canonicalPayload: canonicalizeJson(validPayload2),
        },
        clockParams: {
          nowWallMs: baseTimestampMs + 600_000,
          nowMonoMs: 600_000,
          firstSeenMonoMs: 0,
        },
      },
      {
        id: "valid_lease_number_flag",
        description: "Valid number limit override signed by primary operator",
        type: "lease",
        valid: true,
        envelope: validEnvelope3,
        expected: {
          flagKey: "rate-limit-requests-per-min",
          resolvedValue: 500,
          reason: "OVERRIDE",
          kid: KEYS.ops1.kid,
          canonicalPayload: canonicalizeJson(validPayload3),
        },
        clockParams: {
          nowWallMs: baseTimestampMs + 100_000,
          nowMonoMs: 100_000,
          firstSeenMonoMs: 0,
        },
      },
      {
        id: "valid_lease_object_flag",
        description: "Valid JSON dictionary override signed by root admin",
        type: "lease",
        valid: true,
        envelope: validEnvelope4,
        expected: {
          flagKey: "tracing-config-dynamic",
          resolvedValue: { sample_rate: 0.25, datacenter: "us-east-1" },
          reason: "OVERRIDE",
          kid: KEYS.admin1.kid,
          canonicalPayload: canonicalizeJson(validPayload4),
        },
        clockParams: {
          nowWallMs: baseTimestampMs + 200_000,
          nowMonoMs: 200_000,
          firstSeenMonoMs: 0,
        },
      },
      {
        id: "valid_lease_array_flag",
        description: "Valid JSON array override signed by backup admin",
        type: "lease",
        valid: true,
        envelope: validEnvelope5,
        expected: {
          flagKey: "allowed-user-tiers",
          resolvedValue: ["admin", "beta-tester", "internal"],
          reason: "OVERRIDE",
          kid: KEYS.admin2.kid,
          canonicalPayload: canonicalizeJson(validPayload5),
        },
        clockParams: {
          nowWallMs: baseTimestampMs + 50_000,
          nowMonoMs: 50_000,
          firstSeenMonoMs: 0,
        },
      },
    ],
  };
  writeJson(path.join(FIXTURES_DIR, "leases/valid_leases.json"), validLeases);

  // 2.2 Tampered Payload Leases
  const tamperedPayloadCases = {
    description: "Signed leases whose payload fields were modified post-signing (must fail verification)",
    cases: [
      {
        id: "tampered_payload_value_flipped",
        description: "Boolean value flipped from true to false post-signing",
        type: "lease",
        valid: false,
        envelope: {
          payload: { ...validPayload1, value: false },
          sig: validEnvelope1.sig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "tampered_payload_flag_key_altered",
        description: "flag_key altered from killswitch-payment-v2 to killswitch-payment-v3",
        type: "lease",
        valid: false,
        envelope: {
          payload: { ...validPayload1, flag_key: "killswitch-payment-v3" },
          sig: validEnvelope1.sig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "tampered_payload_ttl_extended",
        description: "ttl_seconds maliciously extended from 1800 to 7200",
        type: "lease",
        valid: false,
        envelope: {
          payload: { ...validPayload1, ttl_seconds: 7200 },
          sig: validEnvelope1.sig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "tampered_payload_issued_at_shifted",
        description: "issued_at shifted into future to artificially delay expiration",
        type: "lease",
        valid: false,
        envelope: {
          payload: { ...validPayload1, issued_at: "2026-10-09T13:00:00.000Z" },
          sig: validEnvelope1.sig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "tampered_payload_kid_swapped",
        description: "kid swapped from ops-primary-01 to admin-root-01",
        type: "lease",
        valid: false,
        envelope: {
          payload: { ...validPayload1, kid: KEYS.admin1.kid },
          sig: validEnvelope1.sig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "tampered_payload_nonce_modified",
        description: "nonce modified post-signing",
        type: "lease",
        valid: false,
        envelope: {
          payload: { ...validPayload1, nonce: "nonce-tampered-12345" },
          sig: validEnvelope1.sig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "tampered_payload_env_changed",
        description: "env field modified from production to staging",
        type: "lease",
        valid: false,
        envelope: {
          payload: { ...validPayload1, env: "staging" },
          sig: validEnvelope1.sig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "tampered_payload_single_byte_mutation",
        description: "Exact single-byte mutation in canonical payload serialization post-signing",
        type: "lease",
        valid: false,
        envelope: {
          payload: {
            ...validPayload1,
            nonce: "monce-random-val-001", // single byte flip in nonce: 'n' (0x6e) -> 'm' (0x6d)
          },
          sig: validEnvelope1.sig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
    ],
  };
  writeJson(path.join(FIXTURES_DIR, "leases/tampered_payload_leases.json"), tamperedPayloadCases);

  // 2.3 Tampered Signature Leases
  // Invert one character of base64url signature
  const origSig = validEnvelope1.sig;
  const bitFlippedSig =
    origSig.charAt(0) === "A"
      ? "B" + origSig.slice(1)
      : "A" + origSig.slice(1);

  // Canonical-base64url malleability (mutating unused padding bits of 86th char)
  const b64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastSigChar = validEnvelope1.sig.slice(-1);
  const lastCharIdx = b64Alphabet.indexOf(lastSigChar);
  const malleatedLastChar = b64Alphabet[lastCharIdx ^ 1];
  const malleatedSig = validEnvelope1.sig.slice(0, -1) + malleatedLastChar;

  const tamperedSigCases = {
    description: "Lease envelopes with corrupted, truncated, or malformed signatures",
    cases: [
      {
        id: "tampered_sig_single_char_flip",
        description: "Single character flipped in 64-byte Ed25519 signature",
        type: "lease",
        valid: false,
        envelope: {
          payload: validPayload1,
          sig: bitFlippedSig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "tampered_sig_canonical_base64url_malleability",
        description: "Signature exhibits base64url padding malleability (non-canonical encoding of same 64 bytes)",
        type: "lease",
        valid: false,
        envelope: {
          payload: validPayload1,
          sig: malleatedSig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "tampered_sig_truncated",
        description: "Signature truncated to 32 bytes (43 base64url chars)",
        type: "lease",
        valid: false,
        envelope: {
          payload: validPayload1,
          sig: origSig.slice(0, 43),
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "tampered_sig_all_zeros",
        description: "Signature replaced with 64 zero bytes base64url",
        type: "lease",
        valid: false,
        envelope: {
          payload: validPayload1,
          sig: Buffer.alloc(64, 0).toString("base64url"),
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "tampered_sig_invalid_base64url_chars",
        description: "Signature contains non-base64url characters (+ and /)",
        type: "lease",
        valid: false,
        envelope: {
          payload: validPayload1,
          sig: origSig.slice(0, 10) + "+//" + origSig.slice(13),
        },
        expectedFailure: "SCHEMA_VALIDATION_FAILED",
      },
      {
        id: "tampered_sig_empty_string",
        description: "Signature is empty string",
        type: "lease",
        valid: false,
        envelope: {
          payload: validPayload1,
          sig: "",
        },
        expectedFailure: "SCHEMA_VALIDATION_FAILED",
      },
    ],
  };
  writeJson(path.join(FIXTURES_DIR, "leases/tampered_sig_leases.json"), tamperedSigCases);

  // 2.4 Cross-Domain Leases (Invariant: Domain Separation)
  const crossDomainRevocationSig = signEnvelope(
    REVOCATION_DOMAIN_PREFIX,
    validPayload1,
    KEYS.ops1.privateKey
  );
  const crossDomainKeyRevocationSig = signEnvelope(
    KEYREVOCATION_DOMAIN_PREFIX,
    validPayload1,
    KEYS.ops1.privateKey
  );
  const crossDomainBogusSig = signEnvelope(
    "synapsestate/audit/v1\n",
    validPayload1,
    KEYS.ops1.privateKey
  );
  const crossDomainEmptySig = signEnvelope(
    "",
    validPayload1,
    KEYS.ops1.privateKey
  );

  const crossDomainCases = {
    description: "Leases signed with alternate domain separation prefixes (must fail verification under Invariant 1 & 2)",
    cases: [
      {
        id: "cross_domain_signed_with_revocation_prefix",
        description: "Lease payload signed using REVOCATION_DOMAIN_PREFIX",
        type: "lease",
        valid: false,
        envelope: crossDomainRevocationSig,
        expectedFailure: "DOMAIN_SEPARATION_MISMATCH",
      },
      {
        id: "cross_domain_signed_with_keyrevocation_prefix",
        description: "Lease payload signed using KEYREVOCATION_DOMAIN_PREFIX",
        type: "lease",
        valid: false,
        envelope: crossDomainKeyRevocationSig,
        expectedFailure: "DOMAIN_SEPARATION_MISMATCH",
      },
      {
        id: "cross_domain_signed_with_bogus_prefix",
        description: "Lease payload signed using audit prefix",
        type: "lease",
        valid: false,
        envelope: crossDomainBogusSig,
        expectedFailure: "DOMAIN_SEPARATION_MISMATCH",
      },
      {
        id: "cross_domain_signed_with_empty_prefix",
        description: "Lease payload signed with no domain prefix",
        type: "lease",
        valid: false,
        envelope: crossDomainEmptySig,
        expectedFailure: "DOMAIN_SEPARATION_MISMATCH",
      },
    ],
  };
  writeJson(path.join(FIXTURES_DIR, "leases/cross_domain_leases.json"), crossDomainCases);

  // 2.5 Expired Wall-Clock Leases
  // validPayload1 has issued_at = baseIso, ttl = 1800s (30m).
  // wall_expiry = baseTimestampMs + 1800_000 + 30_000 skew = baseTimestampMs + 1830_000
  const expiredWallClockCases = {
    description: "Leases with valid Ed25519 signatures evaluated after wall clock expiration (Invariant 3 fail-static)",
    cases: [
      {
        id: "expired_wall_clock_at_exact_skew_limit",
        description: "now_wall reaches issued_at + ttl_seconds + skew_tolerance boundary",
        type: "lease",
        valid: false,
        envelope: validEnvelope1,
        expectedFailure: "EXPIRED_WALL_CLOCK",
        clockParams: {
          nowWallMs: baseTimestampMs + 1800_000 + 30_000, // exact boundary
          nowMonoMs: 100_000,
          firstSeenMonoMs: 0,
          skewToleranceMs: 30_000,
        },
      },
      {
        id: "expired_wall_clock_past_skew_limit",
        description: "now_wall exceeds issued_at + ttl + skew by 10 seconds",
        type: "lease",
        valid: false,
        envelope: validEnvelope1,
        expectedFailure: "EXPIRED_WALL_CLOCK",
        clockParams: {
          nowWallMs: baseTimestampMs + 1800_000 + 40_000,
          nowMonoMs: 100_000,
          firstSeenMonoMs: 0,
          skewToleranceMs: 30_000,
        },
      },
      {
        id: "expired_wall_clock_hours_past",
        description: "now_wall is 2 hours past lease expiration",
        type: "lease",
        valid: false,
        envelope: validEnvelope1,
        expectedFailure: "EXPIRED_WALL_CLOCK",
        clockParams: {
          nowWallMs: baseTimestampMs + 7_200_000,
          nowMonoMs: 100_000,
          firstSeenMonoMs: 0,
          skewToleranceMs: 30_000,
        },
      },
      {
        id: "expired_monotonic_clock_process_elapsed",
        description: "Monotonic process time elapsed past ttl_seconds even if wall clock was rewound",
        type: "lease",
        valid: false,
        envelope: validEnvelope1,
        expectedFailure: "EXPIRED_MONOTONIC",
        clockParams: {
          nowWallMs: baseTimestampMs + 500_000, // Wall clock appears valid
          nowMonoMs: 1800_000, // Monotonic time elapsed full 1800s
          firstSeenMonoMs: 0,
          skewToleranceMs: 30_000,
        },
      },
    ],
  };
  writeJson(path.join(FIXTURES_DIR, "leases/expired_wall_clock_leases.json"), expiredWallClockCases);

  // 2.6 Future-Dated Leases
  const futureDatedCases = {
    description: "Leases with issued_at timestamps ahead of the wall clock beyond skew tolerance (Invariant 3)",
    cases: [
      {
        id: "future_dated_beyond_default_skew",
        description: "issued_at is 45 seconds ahead of now_wall (exceeds 30,000ms tolerance)",
        type: "lease",
        valid: false,
        envelope: validEnvelope1,
        expectedFailure: "FUTURE_DATED",
        clockParams: {
          nowWallMs: baseTimestampMs - 45_000,
          nowMonoMs: 0,
          firstSeenMonoMs: 0,
          skewToleranceMs: 30_000,
        },
      },
      {
        id: "future_dated_extreme_future",
        description: "issued_at is 24 hours in the future",
        type: "lease",
        valid: false,
        envelope: validEnvelope1,
        expectedFailure: "FUTURE_DATED",
        clockParams: {
          nowWallMs: baseTimestampMs - 86_400_000,
          nowMonoMs: 0,
          firstSeenMonoMs: 0,
          skewToleranceMs: 30_000,
        },
      },
    ],
  };
  writeJson(path.join(FIXTURES_DIR, "leases/future_dated_leases.json"), futureDatedCases);

  // 2.7 Unknown Kid Leases (Keyset Policy Seam)
  const unknownKidPayload: LeasePayload = {
    v: 1,
    lease_id: "01J9X000000000000000000099",
    env: "production",
    flag_key: "unauthorized-rogue-override",
    value: true,
    reason: "INC-999: Rogue untrusted operator attempt",
    issued_at: baseIso,
    ttl_seconds: 600,
    kid: KEYS.rogue.kid,
    nonce: "nonce-rogue-val-001",
  };
  const unknownKidEnvelope = signLease(unknownKidPayload, KEYS.rogue.privateKey);

  const unknownKidCases = {
    description: "Lease envelopes signed by valid Ed25519 keys not present in the trusted keyset",
    cases: [
      {
        id: "lease_unknown_kid_not_in_keyset",
        description: "Signed lease with kid missing from Git-pinned keyset",
        type: "lease",
        valid: false,
        envelope: unknownKidEnvelope,
        expectedFailure: "UNKNOWN_KEY",
      },
    ],
  };
  writeJson(path.join(FIXTURES_DIR, "leases/unknown_kid_leases.json"), unknownKidCases);

  // ==========================================
  // 3. REVOCATIONS (fixtures/revocations/)
  // ==========================================
  const validRevocationPayload1: RevocationPayload = {
    v: 1,
    lease_id: "01J9X000000000000000000001",
    revoked_at: "2026-10-09T12:15:00.000Z",
    kid: KEYS.ops1.kid,
    reason: "INC-991: Payment incident resolved; emergency lease recalled",
  };
  const validRevocationEnvelope1 = signRevocation(
    validRevocationPayload1,
    KEYS.ops1.privateKey
  );

  const validRevocationPayload2: RevocationPayload = {
    v: 1,
    lease_id: "01J9X000000000000000000002",
    revoked_at: "2026-10-09T12:20:00.000Z",
    kid: KEYS.admin1.kid,
    reason: "Administrative override revocation",
  };
  const validRevocationEnvelope2 = signRevocation(
    validRevocationPayload2,
    KEYS.admin1.privateKey
  );

  const validRevocations = {
    description: "Valid lease revocation envelopes signed with REVOCATION_DOMAIN_PREFIX",
    cases: [
      {
        id: "valid_revocation_ops_signed",
        description: "Valid lease revocation signed by operator",
        type: "revocation",
        valid: true,
        envelope: validRevocationEnvelope1,
        expected: {
          leaseId: "01J9X000000000000000000001",
          kid: KEYS.ops1.kid,
          canonicalPayload: canonicalizeJson(validRevocationPayload1),
        },
      },
      {
        id: "valid_revocation_admin_signed",
        description: "Valid lease revocation signed by root admin",
        type: "revocation",
        valid: true,
        envelope: validRevocationEnvelope2,
        expected: {
          leaseId: "01J9X000000000000000000002",
          kid: KEYS.admin1.kid,
          canonicalPayload: canonicalizeJson(validRevocationPayload2),
        },
      },
    ],
  };
  writeJson(path.join(FIXTURES_DIR, "revocations/valid_revocations.json"), validRevocations);

  const invalidRevocations = {
    description: "Invalid revocation envelopes (tampered payload, corrupted signature, cross-domain)",
    cases: [
      {
        id: "revocation_tampered_lease_id",
        description: "Revocation payload lease_id altered post-signing",
        type: "revocation",
        valid: false,
        envelope: {
          payload: {
            ...validRevocationPayload1,
            lease_id: "01J9X000000000000000000099",
          },
          sig: validRevocationEnvelope1.sig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "revocation_tampered_sig",
        description: "Corrupted signature characters in revocation envelope",
        type: "revocation",
        valid: false,
        envelope: {
          payload: validRevocationPayload1,
          sig:
            validRevocationEnvelope1.sig.charAt(0) === "A"
              ? "B" + validRevocationEnvelope1.sig.slice(1)
              : "A" + validRevocationEnvelope1.sig.slice(1),
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "revocation_cross_domain_lease_prefix",
        description: "Revocation signed with LEASE_DOMAIN_PREFIX instead of REVOCATION_DOMAIN_PREFIX",
        type: "revocation",
        valid: false,
        envelope: signEnvelope(
          LEASE_DOMAIN_PREFIX,
          validRevocationPayload1,
          KEYS.ops1.privateKey
        ),
        expectedFailure: "DOMAIN_SEPARATION_MISMATCH",
      },
      {
        id: "revocation_unknown_kid",
        description: "Revocation signed by unauthorized key not in trusted keyset",
        type: "revocation",
        valid: false,
        envelope: signRevocation(
          {
            ...validRevocationPayload1,
            kid: KEYS.rogue.kid,
          },
          KEYS.rogue.privateKey
        ),
        expectedFailure: "UNKNOWN_KEY",
      },
      {
        id: "revocation_malformed_timestamp",
        description: "revoked_at is not a valid ISO 8601 UTC timestamp",
        type: "revocation",
        valid: false,
        envelope: {
          payload: {
            ...validRevocationPayload1,
            revoked_at: "invalid-timestamp",
          },
          sig: validRevocationEnvelope1.sig,
        },
        expectedFailure: "SCHEMA_VALIDATION_FAILED",
      },
    ],
  };
  writeJson(path.join(FIXTURES_DIR, "revocations/invalid_revocations.json"), invalidRevocations);

  // ==========================================
  // 4. KEY REVOCATIONS (fixtures/key_revocations/)
  // ==========================================
  const validKeyRevocationPayload1: KeyRevocationPayload = {
    v: 1,
    kid: KEYS.ops2.kid,
    revoked_at: "2026-10-09T12:30:00.000Z",
    revoked_by_kid: KEYS.admin1.kid,
    reason: "INC-996: Operator workstation lost; credential revoked",
  };
  const validKeyRevocationEnvelope1 = signKeyRevocation(
    validKeyRevocationPayload1,
    KEYS.admin1.privateKey
  );

  const validKeyRevocationPayload2: KeyRevocationPayload = {
    v: 1,
    kid: KEYS.ops1.kid,
    revoked_at: "2026-10-09T12:35:00.000Z",
    revoked_by_kid: KEYS.admin2.kid,
    reason: "Planned key rotation by backup administrator",
  };
  const validKeyRevocationEnvelope2 = signKeyRevocation(
    validKeyRevocationPayload2,
    KEYS.admin2.privateKey
  );

  const validKeyRevocations = {
    description: "Valid key revocation envelopes signed by admin with KEYREVOCATION_DOMAIN_PREFIX",
    cases: [
      {
        id: "valid_key_revocation_compromised_operator",
        description: "Admin key revocation dropping compromised operator key",
        type: "key_revocation",
        valid: true,
        envelope: validKeyRevocationEnvelope1,
        expected: {
          kid: KEYS.admin1.kid,
          revokedKid: KEYS.ops2.kid,
          canonicalPayload: canonicalizeJson(validKeyRevocationPayload1),
        },
      },
      {
        id: "valid_key_revocation_with_revoked_by_kid",
        description: "Backup admin key revocation specifying revoked_by_kid",
        type: "key_revocation",
        valid: true,
        envelope: validKeyRevocationEnvelope2,
        expected: {
          kid: KEYS.admin2.kid,
          revokedKid: KEYS.ops1.kid,
          canonicalPayload: canonicalizeJson(validKeyRevocationPayload2),
        },
      },
    ],
  };
  writeJson(path.join(FIXTURES_DIR, "key_revocations/valid_key_revocations.json"), validKeyRevocations);

  const invalidKeyRevocations = {
    description: "Invalid key revocation envelopes (tampered payload, corrupted signature, unauthorized operator signer)",
    cases: [
      {
        id: "key_revocation_tampered_kid",
        description: "Key revocation kid changed post-signing",
        type: "key_revocation",
        valid: false,
        envelope: {
          payload: {
            ...validKeyRevocationPayload1,
            kid: KEYS.admin1.kid,
          },
          sig: validKeyRevocationEnvelope1.sig,
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "key_revocation_tampered_sig",
        description: "Corrupted signature in key revocation envelope",
        type: "key_revocation",
        valid: false,
        envelope: {
          payload: validKeyRevocationPayload1,
          sig:
            validKeyRevocationEnvelope1.sig.charAt(0) === "A"
              ? "B" + validKeyRevocationEnvelope1.sig.slice(1)
              : "A" + validKeyRevocationEnvelope1.sig.slice(1),
        },
        expectedFailure: "SIGNATURE_INVALID",
      },
      {
        id: "key_revocation_cross_domain",
        description: "Key revocation signed with LEASE_DOMAIN_PREFIX",
        type: "key_revocation",
        valid: false,
        envelope: signEnvelope(
          LEASE_DOMAIN_PREFIX,
          validKeyRevocationPayload1,
          KEYS.admin1.privateKey
        ),
        expectedFailure: "DOMAIN_SEPARATION_MISMATCH",
      },
      {
        id: "key_revocation_signed_by_operator",
        description: "Operator attempted to sign key revocation (only admin role is authorized)",
        type: "key_revocation",
        valid: false,
        envelope: signKeyRevocation(
          {
            ...validKeyRevocationPayload1,
            kid: KEYS.ops2.kid,
            revoked_by_kid: KEYS.ops1.kid,
          },
          KEYS.ops1.privateKey
        ),
        expectedFailure: "UNAUTHORIZED_SIGNER",
      },
      {
        id: "key_revocation_unknown_signer",
        description: "Key revocation signed by untrusted rogue key",
        type: "key_revocation",
        valid: false,
        envelope: signKeyRevocation(
          {
            ...validKeyRevocationPayload1,
            kid: KEYS.ops2.kid,
            revoked_by_kid: KEYS.rogue.kid,
          },
          KEYS.rogue.privateKey
        ),
        expectedFailure: "UNKNOWN_KEY",
      },
    ],
  };
  writeJson(path.join(FIXTURES_DIR, "key_revocations/invalid_key_revocations.json"), invalidKeyRevocations);

  console.log("Golden conformance fixtures generated successfully!");
}

// Execute if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateAllFixtures();
}
