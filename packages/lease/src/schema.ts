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
 * Schema for emergency break-glass lease payloads.
 */
export const LeasePayloadSchema = z.object({
  v: z.literal(1),
  lease_id: z.string().min(1, "lease_id must not be empty"),
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
  kid: z.string().min(1, "kid must not be empty"),
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
  lease_id: z.string().min(1, "lease_id must not be empty"),
  revoked_at: z
    .string()
    .datetime({ message: "revoked_at must be an ISO 8601 UTC timestamp" }),
  kid: z.string().min(1, "kid must not be empty"),
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
  kid: z.string().min(1, "kid must not be empty"),
  revoked_at: z
    .string()
    .datetime({ message: "revoked_at must be an ISO 8601 UTC timestamp" }),
  revoked_by_kid: z
    .string()
    .min(1, "revoked_by_kid must not be empty")
    .optional(),
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
 * Schema for individual key entries in a keyset.
 */
export const KeysetKeySchema = z.object({
  public_key: z.string().min(1, "public_key must not be empty"),
  role: z.enum(["operator", "admin"]),
  max_ttl_seconds: z.number().int().positive().max(86400).optional(),
});

export type KeysetKey = z.infer<typeof KeysetKeySchema>;

/**
 * Keyset dictionary mapping key ID to authorized key metadata.
 * An empty object `{}` is explicitly valid as an authoritative "revoke all keys" directive.
 */
export const KeysetSchema = z.record(KeysetKeySchema);

export type Keyset = z.infer<typeof KeysetSchema>;
