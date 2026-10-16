import { z } from "zod";

/**
 * Charset invariant: flag keys must match ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$
 * Enforces lowercase alphanumeric and hyphens without consecutive or edge hyphens.
 */
export const FLAG_KEY_REGEX = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * Base64URL string pattern (URL and filename safe alphabet, no padding)
 */
export const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * Crockford Base32 pattern for 26-character ULIDs
 */
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Charset invariant for keyset identifiers: alphanumeric, hyphens, and underscores, max 64 chars.
 * Prevents prototype pollution, control characters, and unbounded allocation.
 */
export const KID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Forbidden JavaScript prototype property names that must never be accepted as key identifiers.
 */
export const FORBIDDEN_KID_NAMES = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
] as const);

/**
 * Defensive schema for key identifiers (kid).
 */
export const KidSchema = z
  .string()
  .min(1, "kid must not be empty")
  .max(64, "kid must not exceed 64 characters")
  .regex(
    KID_REGEX,
    "kid must contain only alphanumeric characters, dashes, and underscores (max 64 chars)",
  )
  .refine(
    (kid) =>
      kid !== "__proto__" && kid !== "constructor" && kid !== "prototype",
    { message: "kid must not use reserved prototype properties" },
  );

/**
 * Schema for emergency break-glass lease payloads.
 */
export const LeasePayloadSchema = z.object({
  v: z.literal(1),
  lease_id: z
    .string()
    .regex(ULID_REGEX, "lease_id must be a valid 26-character Crockford ULID"),
  env: z.string().min(1, "env must not be empty"),
  flag_key: z
    .string()
    .regex(
      FLAG_KEY_REGEX,
      "flag_key must match ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
    ),
  value: z.union([
    z.boolean(),
    z.string(),
    z.number().finite("number value must be finite"),
    z.record(z.unknown()),
    z.array(z.unknown()),
  ]),
  reason: z.string().min(1, "reason must not be empty"),
  issued_at: z
    .string()
    .datetime({ message: "issued_at must be an ISO 8601 UTC timestamp" }),
  ttl_seconds: z
    .number()
    .int()
    .positive("ttl_seconds must be positive")
    .max(86400, "ttl_seconds must not exceed 86400 (24h)"),
  kid: KidSchema,
  nonce: z.string().min(1, "nonce must not be empty"),
});

export type LeasePayload = z.infer<typeof LeasePayloadSchema>;

/**
 * Schema for signed lease envelopes containing payload and Ed25519 signature.
 */
export const LeaseEnvelopeSchema = z.object({
  payload: LeasePayloadSchema,
  sig: z
    .string()
    .min(1, "sig must not be empty")
    .regex(BASE64URL_REGEX, "sig must be base64url encoded"),
});

export type LeaseEnvelope = z.infer<typeof LeaseEnvelopeSchema>;

/**
 * Schema for lease revocation payloads.
 */
export const RevocationPayloadSchema = z.object({
  v: z.literal(1),
  lease_id: z
    .string()
    .regex(ULID_REGEX, "lease_id must be a valid 26-character Crockford ULID"),
  revoked_at: z
    .string()
    .datetime({ message: "revoked_at must be an ISO 8601 UTC timestamp" }),
  kid: KidSchema,
  reason: z.string().min(1, "reason must not be empty"),
});

export type RevocationPayload = z.infer<typeof RevocationPayloadSchema>;

/**
 * Schema for signed revocation envelopes.
 */
export const RevocationEnvelopeSchema = z.object({
  payload: RevocationPayloadSchema,
  sig: z
    .string()
    .min(1, "sig must not be empty")
    .regex(BASE64URL_REGEX, "sig must be base64url encoded"),
});

export type RevocationEnvelope = z.infer<typeof RevocationEnvelopeSchema>;

/**
 * Schema for signed key revocation payloads (fast-path key dropping).
 */
export const KeyRevocationPayloadSchema = z.object({
  v: z.literal(1),
  kid: KidSchema,
  revoked_at: z
    .string()
    .datetime({ message: "revoked_at must be an ISO 8601 UTC timestamp" }),
  revoked_by_kid: KidSchema.optional(),
  reason: z.string().min(1, "reason must not be empty"),
});

export type KeyRevocationPayload = z.infer<typeof KeyRevocationPayloadSchema>;

/**
 * Schema for signed key revocation envelopes.
 */
export const KeyRevocationEnvelopeSchema = z.object({
  payload: KeyRevocationPayloadSchema,
  sig: z
    .string()
    .min(1, "sig must not be empty")
    .regex(BASE64URL_REGEX, "sig must be base64url encoded"),
});

export type KeyRevocationEnvelope = z.infer<typeof KeyRevocationEnvelopeSchema>;

/**
 * Schema for signed audit checkpoint payloads (external anchoring).
 */
export const CheckpointPayloadSchema = z.object({
  v: z.literal(1),
  checkpoint_seq: z.number().int().nonnegative(),
  checkpoint_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "checkpoint_hash must be a 64-char lowercase hex SHA-256 string"),
  timestamp: z
    .string()
    .datetime({ message: "timestamp must be an ISO 8601 UTC timestamp" }),
  sealed_count: z.number().int().nonnegative(),
  kid: KidSchema,
});

export type CheckpointPayload = z.infer<typeof CheckpointPayloadSchema>;

/**
 * Schema for signed checkpoint envelopes.
 */
export const CheckpointEnvelopeSchema = z.object({
  payload: CheckpointPayloadSchema,
  sig: z
    .string()
    .min(1, "sig must not be empty")
    .regex(BASE64URL_REGEX, "sig must be base64url encoded"),
});

export type CheckpointEnvelope = z.infer<typeof CheckpointEnvelopeSchema>;

/**
 * Supported key roles and permissions (ARCHITECTURE.md:286, 309).
 */
export const KEY_ROLE_VALUES = [
  "lease_signer",
  "key_revoker",
  "operator",
  "admin",
  "audit_signer",
  "checkpoint_signer",
] as const;

export type KeyRole = (typeof KEY_ROLE_VALUES)[number];

/**
 * Supported key lifecycle statuses.
 */
export const KEY_STATUS_VALUES = ["active", "revoked", "suspended"] as const;

export type KeyStatus = (typeof KEY_STATUS_VALUES)[number];

/**
 * Raw input schema for individual key entries in a keyset.
 * Supports both modern array-based `roles` and legacy `role: "operator" | "admin"`.
 */
export const KeysetKeySchema = z
  .object({
    public_key: z.string().min(1, "public_key must not be empty"),
    role: z.enum(["operator", "admin"]).optional(),
    roles: z.array(z.enum(KEY_ROLE_VALUES)).min(1).optional(),
    status: z.enum(KEY_STATUS_VALUES).default("active"),
    max_ttl_seconds: z.number().int().positive().max(86400).optional(),
  })
  .refine((key) => key.role !== undefined || key.roles !== undefined, {
    message: "Either 'role' or 'roles' must be specified for keyset entry",
  })
  .transform((key) => {
    const roleSet = new Set<KeyRole>(key.roles ?? []);
    if (key.role) {
      roleSet.add(key.role);
      if (key.role === "admin") {
        roleSet.add("lease_signer");
        roleSet.add("key_revoker");
        roleSet.add("audit_signer");
        roleSet.add("checkpoint_signer");
      } else if (key.role === "operator") {
        roleSet.add("lease_signer");
      }
    } else {
      if (roleSet.has("admin")) {
        roleSet.add("lease_signer");
        roleSet.add("key_revoker");
        roleSet.add("audit_signer");
        roleSet.add("checkpoint_signer");
      }
      if (roleSet.has("operator")) {
        roleSet.add("lease_signer");
      }
    }

    const resolvedRole: "operator" | "admin" | undefined =
      key.role ??
      (roleSet.has("admin")
        ? "admin"
        : roleSet.has("operator")
          ? "operator"
          : undefined);

    return {
      public_key: key.public_key,
      role: resolvedRole,
      roles: Array.from(roleSet),
      status: key.status,
      max_ttl_seconds: key.max_ttl_seconds,
    };
  });

export type KeysetKey = z.output<typeof KeysetKeySchema>;

/**
 * Keyset dictionary mapping key ID to authorized key metadata.
 * An empty object `{}` is explicitly valid as an authoritative "revoke all keys" directive.
 */
export const KeysetSchema = z.record(KidSchema, KeysetKeySchema);

export type Keyset = Record<string, KeysetKey>;
