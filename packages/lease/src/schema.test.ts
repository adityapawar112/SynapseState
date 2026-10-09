import { describe, it, expect } from "vitest";
import {
  LeasePayloadSchema,
  LeaseEnvelopeSchema,
  RevocationPayloadSchema,
  RevocationEnvelopeSchema,
  KeyRevocationPayloadSchema,
  KeyRevocationEnvelopeSchema,
  KeysetSchema,
  KeysetKeySchema,
} from "./schema.js";

describe("LeasePayloadSchema", () => {
  const validPayload = {
    v: 1 as const,
    lease_id: "01J9X57YTRPQ8A7F4E12345678",
    env: "prod",
    flag_key: "checkout-v2",
    value: false,
    reason: "INC-142: Database connection pool exhaustion",
    issued_at: "2026-10-06T02:14:00.000Z",
    ttl_seconds: 1800,
    kid: "sre-alice-2026-01",
    nonce: "NzkxZDJiODRhYTgzYTAyMzg4Y2M5",
  };

  it("successfully parses a valid lease payload", () => {
    const result = LeasePayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.flag_key).toBe("checkout-v2");
      expect(result.data.ttl_seconds).toBe(1800);
      expect(result.data.value).toBe(false);
    }
  });

  it("rejects version other than 1", () => {
    const result = LeasePayloadSchema.safeParse({ ...validPayload, v: 2 });
    expect(result.success).toBe(false);
  });

  it("rejects empty lease_id", () => {
    const result = LeasePayloadSchema.safeParse({
      ...validPayload,
      lease_id: "",
    });
    expect(result.success).toBe(false);
  });

  it("validates flag_key charset invariant ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", () => {
    // Valid keys
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, flag_key: "a" }).success,
    ).toBe(true);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, flag_key: "checkout-v2" })
        .success,
    ).toBe(true);
    expect(
      LeasePayloadSchema.safeParse({
        ...validPayload,
        flag_key: "feature-123-abc",
      }).success,
    ).toBe(true);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, flag_key: "0-flag-1" })
        .success,
    ).toBe(true);

    // Invalid keys: uppercase, underscores, dots, leading/trailing hyphens, spaces
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, flag_key: "CheckoutV2" })
        .success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, flag_key: "checkout_v2" })
        .success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, flag_key: "checkout.v2" })
        .success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, flag_key: "-checkout" })
        .success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, flag_key: "checkout-" })
        .success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, flag_key: "checkout v2" })
        .success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, flag_key: "" }).success,
    ).toBe(false);
  });

  it("supports boolean, string, number, and JSON object values", () => {
    // Boolean
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, value: true }).success,
    ).toBe(true);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, value: false }).success,
    ).toBe(true);

    // String
    expect(
      LeasePayloadSchema.safeParse({
        ...validPayload,
        value: "experiment-blue",
      }).success,
    ).toBe(true);

    // Number
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, value: 42 }).success,
    ).toBe(true);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, value: 3.14159 }).success,
    ).toBe(true);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, value: 0 }).success,
    ).toBe(true);

    // JSON object
    expect(
      LeasePayloadSchema.safeParse({
        ...validPayload,
        value: { max_retries: 5, enabled: true, ratio: 0.5 },
      }).success,
    ).toBe(true);

    // Invalid values
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, value: NaN }).success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, value: Infinity })
        .success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, value: undefined })
        .success,
    ).toBe(false);
  });

  it("enforces ttl_seconds bounds: positive integer <= 86400", () => {
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, ttl_seconds: 1 }).success,
    ).toBe(true);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, ttl_seconds: 86400 })
        .success,
    ).toBe(true);

    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, ttl_seconds: 0 }).success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, ttl_seconds: -10 })
        .success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, ttl_seconds: 86401 })
        .success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, ttl_seconds: 1800.5 })
        .success,
    ).toBe(false);
  });

  it("enforces ISO 8601 UTC timestamp format for issued_at", () => {
    expect(
      LeasePayloadSchema.safeParse({
        ...validPayload,
        issued_at: "2026-10-06T02:14:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      LeasePayloadSchema.safeParse({
        ...validPayload,
        issued_at: "2026-10-06T02:14:00Z",
      }).success,
    ).toBe(true);

    // Invalid timestamps
    expect(
      LeasePayloadSchema.safeParse({ ...validPayload, issued_at: "not-a-date" })
        .success,
    ).toBe(false);
    expect(
      LeasePayloadSchema.safeParse({
        ...validPayload,
        issued_at: "2026/10/06 02:14:00",
      }).success,
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    const withoutNonce = { ...validPayload } as Record<string, unknown>;
    delete withoutNonce.nonce;
    expect(LeasePayloadSchema.safeParse(withoutNonce).success).toBe(false);

    const withoutKid = { ...validPayload } as Record<string, unknown>;
    delete withoutKid.kid;
    expect(LeasePayloadSchema.safeParse(withoutKid).success).toBe(false);

    const withoutEnv = { ...validPayload } as Record<string, unknown>;
    delete withoutEnv.env;
    expect(LeasePayloadSchema.safeParse(withoutEnv).success).toBe(false);
  });
});

describe("LeaseEnvelopeSchema", () => {
  const validEnvelope = {
    payload: {
      v: 1 as const,
      lease_id: "01J9X57YTRPQ8A7F4E12345678",
      env: "prod",
      flag_key: "checkout-v2",
      value: false,
      reason: "INC-142",
      issued_at: "2026-10-06T02:14:00.000Z",
      ttl_seconds: 1800,
      kid: "sre-alice-2026-01",
      nonce: "NzkxZDJiODRhYTgzYTAyMzg4Y2M5",
    },
    sig: "MEQCID7w_some_base64url_sig_without_padding_12345",
  };

  it("accepts valid envelope with base64url signature", () => {
    const result = LeaseEnvelopeSchema.safeParse(validEnvelope);
    expect(result.success).toBe(true);
  });

  it("rejects non-base64url characters in signature", () => {
    expect(
      LeaseEnvelopeSchema.safeParse({
        ...validEnvelope,
        sig: "invalid+sig/with=padding==",
      }).success,
    ).toBe(false);
  });

  it("rejects missing signature", () => {
    expect(
      LeaseEnvelopeSchema.safeParse({
        payload: validEnvelope.payload,
      }).success,
    ).toBe(false);
  });
});

describe("RevocationPayloadSchema & Envelope", () => {
  const validRevocation = {
    v: 1 as const,
    lease_id: "01J9X57YTRPQ8A7F4E12345678",
    revoked_at: "2026-10-06T02:25:00.000Z",
    kid: "sre-alice-2026-01",
    reason: "Incident resolved early",
  };

  it("parses valid revocation payload", () => {
    expect(RevocationPayloadSchema.safeParse(validRevocation).success).toBe(
      true,
    );
  });

  it("rejects invalid revocation payload", () => {
    expect(
      RevocationPayloadSchema.safeParse({ ...validRevocation, v: 2 }).success,
    ).toBe(false);
    expect(
      RevocationPayloadSchema.safeParse({
        ...validRevocation,
        revoked_at: "invalid",
      }).success,
    ).toBe(false);
    expect(
      RevocationPayloadSchema.safeParse({ ...validRevocation, reason: "" })
        .success,
    ).toBe(false);
  });

  it("parses valid revocation envelope", () => {
    expect(
      RevocationEnvelopeSchema.safeParse({
        payload: validRevocation,
        sig: "sig_b64url_123",
      }).success,
    ).toBe(true);
  });
});

describe("KeyRevocationPayloadSchema & Envelope", () => {
  const validKeyRevocation = {
    v: 1 as const,
    kid: "compromised-key-id",
    revoked_at: "2026-10-06T02:25:00.000Z",
    revoked_by_kid: "security-lead",
    reason: "Laptop reported lost",
  };

  it("parses valid key revocation payload with revoked_by_kid", () => {
    expect(
      KeyRevocationPayloadSchema.safeParse(validKeyRevocation).success,
    ).toBe(true);
  });

  it("parses valid key revocation payload without revoked_by_kid", () => {
    const withoutRevokedBy = { ...validKeyRevocation } as Record<
      string,
      unknown
    >;
    delete withoutRevokedBy.revoked_by_kid;
    expect(KeyRevocationPayloadSchema.safeParse(withoutRevokedBy).success).toBe(
      true,
    );
  });

  it("rejects invalid key revocation", () => {
    expect(
      KeyRevocationPayloadSchema.safeParse({ ...validKeyRevocation, kid: "" })
        .success,
    ).toBe(false);
  });

  it("parses valid key revocation envelope", () => {
    expect(
      KeyRevocationEnvelopeSchema.safeParse({
        payload: validKeyRevocation,
        sig: "sig_b64url_456",
      }).success,
    ).toBe(true);
  });
});

describe("KeysetSchema", () => {
  it("accepts valid keyset with operator and admin roles", () => {
    const keyset = {
      "sre-alice": {
        public_key:
          "e4d909c290d0fb1ca068ffaddf22cbd0add8b35e803f29631623b0d1e592e3a7",
        role: "operator" as const,
        max_ttl_seconds: 3600,
      },
      "lead-bob": {
        public_key: "MCowBQYDK2VwAyEA5NkKj_abc123rawOrSpkiPublicKeyBytes",
        role: "admin" as const,
      },
    };

    const result = KeysetSchema.safeParse(keyset);
    expect(result.success).toBe(true);
  });

  it("accepts valid empty object {} as explicit revoke-all-keys directive", () => {
    const result = KeysetSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).length).toBe(0);
    }
  });

  it("rejects unauthorized roles", () => {
    const result = KeysetKeySchema.safeParse({
      public_key: "some-key",
      role: "superuser",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid max_ttl_seconds", () => {
    expect(
      KeysetKeySchema.safeParse({
        public_key: "some-key",
        role: "operator",
        max_ttl_seconds: 0,
      }).success,
    ).toBe(false);

    expect(
      KeysetKeySchema.safeParse({
        public_key: "some-key",
        role: "operator",
        max_ttl_seconds: 100000,
      }).success,
    ).toBe(false);
  });
});
