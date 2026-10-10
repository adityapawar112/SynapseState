import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
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
  KeysetParseError,
  KeysetValidationError,
} from "./keyset.js";
import {
  formatPublicKeyToHex,
  signLease,
  signRevocation,
  signKeyRevocation,
} from "./crypto.js";
import type { KeyRevocationPayload, LeasePayload } from "./schema.js";

describe("Keyset Parser & Validator", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const hexPublicKey = formatPublicKeyToHex(publicKey);

  it("parses valid keyset JSON with operator and admin roles", () => {
    const rawJson = JSON.stringify({
      "sre-alice": {
        public_key: hexPublicKey,
        role: "operator",
        max_ttl_seconds: 3600,
      },
      "security-lead": {
        public_key: hexPublicKey,
        role: "admin",
      },
    });

    const keyset = parseKeysetJson(rawJson);
    expect(hasKey(keyset, "sre-alice")).toBe(true);
    expect(hasKey(keyset, "security-lead")).toBe(true);
    expect(hasKey(keyset, "unknown-kid")).toBe(false);

    const aliceKey = getKey(keyset, "sre-alice");
    expect(aliceKey).toBeDefined();
    expect(aliceKey?.role).toBe("operator");
    expect(aliceKey?.roles).toContain("operator");
    expect(aliceKey?.roles).toContain("lease_signer");
    expect(aliceKey?.status).toBe("active");
    expect(aliceKey?.max_ttl_seconds).toBe(3600);
  });

  it("returns a null-prototype dictionary to prevent prototype pollution", () => {
    const rawJson = JSON.stringify({
      "sre-alice": {
        public_key: hexPublicKey,
        role: "operator",
      },
    });

    const keyset = parseKeysetJson(rawJson);
    expect(Object.getPrototypeOf(keyset)).toBeNull();
    expect(keyset.constructor).toBeUndefined();
    expect(keyset.__proto__).toBeUndefined();
  });

  it("rejects prototype pollution attempts: __proto__, constructor, prototype", () => {
    const protoJson = `{"__proto__": {"public_key": "${hexPublicKey}", "role": "operator"}}`;
    expect(() => parseKeysetJson(protoJson)).toThrow(KeysetValidationError);

    const constructorJson = `{"constructor": {"public_key": "${hexPublicKey}", "role": "operator"}}`;
    expect(() => parseKeysetJson(constructorJson)).toThrow(
      KeysetValidationError,
    );

    const prototypeJson = `{"prototype": {"public_key": "${hexPublicKey}", "role": "operator"}}`;
    expect(() => parseKeysetJson(prototypeJson)).toThrow(KeysetValidationError);
  });

  it("rejects key identifiers exceeding 64 characters or containing illegal characters", () => {
    const longKid = "a".repeat(65);
    const longKidJson = JSON.stringify({
      [longKid]: {
        public_key: hexPublicKey,
        role: "operator",
      },
    });
    expect(() => parseKeysetJson(longKidJson)).toThrow(KeysetValidationError);

    const illegalCharKidJson = JSON.stringify({
      "kid with spaces": {
        public_key: hexPublicKey,
        role: "operator",
      },
    });
    expect(() => parseKeysetJson(illegalCharKidJson)).toThrow(
      KeysetValidationError,
    );
  });

  it("parses Buffer input as UTF-8 JSON", () => {
    const buffer = Buffer.from(
      JSON.stringify({
        "sre-alice": {
          public_key: hexPublicKey,
          role: "operator",
        },
      }),
      "utf8",
    );

    const keyset = parseKeysetJson(buffer);
    expect(hasKey(keyset, "sre-alice")).toBe(true);
  });

  it("enforces valid empty JSON {} as an explicit 'revoke all keys' state", () => {
    const keyset = parseKeysetJson("{}");
    expect(keyset).toEqual({});
    expect(Object.keys(keyset).length).toBe(0);
    expect(hasKey(keyset, "any-key")).toBe(false);
    expect(getKey(keyset, "any-key")).toBeUndefined();
  });

  it("throws TypeError on non-string, non-buffer inputs", () => {
    // @ts-expect-error test runtime validation for untyped callers
    expect(() => parseKeysetJson(123)).toThrow(TypeError);
    // @ts-expect-error test runtime validation for untyped callers
    expect(() => parseKeysetJson(null)).toThrow(TypeError);
  });

  it("throws KeysetParseError on malformed JSON or empty string", () => {
    expect(() => parseKeysetJson("")).toThrow(KeysetParseError);
    expect(() => parseKeysetJson("{ not valid json")).toThrow(KeysetParseError);
    expect(() => parseKeysetJson("   ")).toThrow(KeysetParseError);
  });

  it("throws KeysetValidationError on invalid keyset schema", () => {
    // Array instead of object
    expect(() => parseKeysetJson("[]")).toThrow(KeysetValidationError);

    // Empty kid key
    const emptyKidJson = JSON.stringify({
      "": {
        public_key: hexPublicKey,
        role: "operator",
      },
    });
    expect(() => parseKeysetJson(emptyKidJson)).toThrow(KeysetValidationError);

    // Invalid role
    const invalidRoleJson = JSON.stringify({
      "sre-bob": {
        public_key: hexPublicKey,
        role: "unauthorized_role",
      },
    });
    expect(() => parseKeysetJson(invalidRoleJson)).toThrow(
      KeysetValidationError,
    );

    // Invalid max_ttl_seconds
    const invalidTtlJson = JSON.stringify({
      "sre-bob": {
        public_key: hexPublicKey,
        role: "operator",
        max_ttl_seconds: -100,
      },
    });
    expect(() => parseKeysetJson(invalidTtlJson)).toThrow(
      KeysetValidationError,
    );
  });

  it("throws KeysetValidationError if public_key is not a valid Ed25519 key", () => {
    const invalidKeyBytesJson = JSON.stringify({
      "sre-bob": {
        public_key: "not-a-valid-ed25519-public-key",
        role: "operator",
      },
    });
    expect(() => parseKeysetJson(invalidKeyBytesJson)).toThrow(
      KeysetValidationError,
    );
  });

  describe("Role and Permission Authorization Helpers", () => {
    it("distinguishes lease_signer and key_revoker capabilities", () => {
      const keyset = parseKeysetJson(
        JSON.stringify({
          "operator-key": {
            public_key: hexPublicKey,
            role: "operator",
          },
          "admin-key": {
            public_key: hexPublicKey,
            role: "admin",
          },
          "only-revoker": {
            public_key: hexPublicKey,
            roles: ["key_revoker"],
          },
          "suspended-admin": {
            public_key: hexPublicKey,
            role: "admin",
            status: "suspended",
          },
        }),
      );

      const opKey = getKey(keyset, "operator-key")!;
      expect(isKeyActive(opKey)).toBe(true);
      expect(canSignLease(opKey)).toBe(true);
      expect(canRevokeLease(opKey)).toBe(true);
      expect(canRevokeKey(opKey)).toBe(false);

      const adminKey = getKey(keyset, "admin-key")!;
      expect(isKeyActive(adminKey)).toBe(true);
      expect(canSignLease(adminKey)).toBe(true);
      expect(canRevokeKey(adminKey)).toBe(true);

      const revokerKey = getKey(keyset, "only-revoker")!;
      expect(isKeyActive(revokerKey)).toBe(true);
      expect(canSignLease(revokerKey)).toBe(false);
      expect(canRevokeKey(revokerKey)).toBe(true);

      const suspendedKey = getKey(keyset, "suspended-admin")!;
      expect(isKeyActive(suspendedKey)).toBe(false);
      expect(canSignLease(suspendedKey)).toBe(false);
      expect(canRevokeKey(suspendedKey)).toBe(false);
    });
  });

  describe("Keyset Policy-Enforcing Verification", () => {
    const validLeasePayload: LeasePayload = {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4E12345678",
      env: "prod",
      flag_key: "checkout-v2",
      value: true,
      reason: "Emergency test",
      issued_at: "2026-10-06T02:00:00.000Z",
      ttl_seconds: 1800,
      kid: "sre-alice",
      nonce: "nonce123",
    };

    it("verifies lease when kid has lease_signer authorization within max_ttl_seconds", () => {
      const keyset = parseKeysetJson(
        JSON.stringify({
          "sre-alice": {
            public_key: hexPublicKey,
            role: "operator",
            max_ttl_seconds: 3600,
          },
        }),
      );

      const envelope = signLease(validLeasePayload, privateKey);
      expect(verifyLeaseWithKeyset(envelope, keyset)).toBe(true);
    });

    it("rejects lease when ttl_seconds exceeds key's max_ttl_seconds policy", () => {
      const keyset = parseKeysetJson(
        JSON.stringify({
          "sre-alice": {
            public_key: hexPublicKey,
            role: "operator",
            max_ttl_seconds: 600, // 10 min ceiling
          },
        }),
      );

      // payload has ttl_seconds: 1800 (> 600)
      const envelope = signLease(validLeasePayload, privateKey);
      expect(verifyLeaseWithKeyset(envelope, keyset)).toBe(false);
    });

    it("rejects lease signed by a key lacking lease_signer role", () => {
      const keyset = parseKeysetJson(
        JSON.stringify({
          "sre-alice": {
            public_key: hexPublicKey,
            roles: ["key_revoker"], // revoker only, not lease signer
          },
        }),
      );

      const envelope = signLease(validLeasePayload, privateKey);
      expect(verifyLeaseWithKeyset(envelope, keyset)).toBe(false);
    });

    it("verifies lease revocation when signed by authorized lease signer", () => {
      const keyset = parseKeysetJson(
        JSON.stringify({
          "sre-alice": {
            public_key: hexPublicKey,
            role: "operator",
          },
        }),
      );

      const revocationPayload = {
        v: 1 as const,
        lease_id: validLeasePayload.lease_id,
        revoked_at: "2026-10-06T02:15:00.000Z",
        kid: "sre-alice",
        reason: "Incident mitigated early",
      };

      const envelope = signRevocation(revocationPayload, privateKey);
      expect(verifyRevocationWithKeyset(envelope, keyset)).toBe(true);
    });

    it("enforces key revocation policy: only key_revoker or admin role can revoke keys", () => {
      const keyset = parseKeysetJson(
        JSON.stringify({
          "sec-admin": {
            public_key: hexPublicKey,
            role: "admin",
          },
          "standard-op": {
            public_key: hexPublicKey,
            role: "operator",
          },
        }),
      );

      const keyRevocationPayload = {
        v: 1 as const,
        kid: "compromised-key",
        revoked_at: "2026-10-06T02:30:00.000Z",
        revoked_by_kid: "sec-admin",
        reason: "Key compromised",
      };

      const envelopeByAdmin = signKeyRevocation(
        keyRevocationPayload,
        privateKey,
      );
      expect(verifyKeyRevocationWithKeyset(envelopeByAdmin, keyset)).toBe(true);

      const payloadByOp = {
        ...keyRevocationPayload,
        revoked_by_kid: "standard-op",
      };
      const envelopeByOp = signKeyRevocation(payloadByOp, privateKey);
      expect(verifyKeyRevocationWithKeyset(envelopeByOp, keyset)).toBe(false);
    });
  });

  describe("isKeyRevoked helper", () => {
    const revocations: KeyRevocationPayload[] = [
      {
        v: 1,
        kid: "compromised-key",
        revoked_at: "2026-10-06T02:00:00.000Z",
        reason: "Lost laptop",
      },
    ];

    it("returns true when key is in revocation list", () => {
      expect(isKeyRevoked("compromised-key", revocations)).toBe(true);
    });

    it("returns false when key is not in revocation list", () => {
      expect(isKeyRevoked("sre-alice", revocations)).toBe(false);
      expect(isKeyRevoked("other-key", [])).toBe(false);
    });
  });
});
