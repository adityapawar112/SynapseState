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

  describe("KeysetParser Error Invariants & Edge Cases", () => {
    it("preserves custom Error class names and error causes", () => {
      const parseErr = new KeysetParseError("bad json", {
        cause: new Error("inner"),
      });
      expect(parseErr.name).toBe("KeysetParseError");
      expect(parseErr.message).toBe("bad json");
      expect(parseErr.cause).toBeDefined();

      const valErr = new KeysetValidationError("bad schema", {
        cause: new Error("inner"),
      });
      expect(valErr.name).toBe("KeysetValidationError");
      expect(valErr.message).toBe("bad schema");
      expect(valErr.cause).toBeDefined();
    });

    it("enforces type check and exact error message for non-string, non-buffer inputs", () => {
      expect(() => parseKeysetJson(null as any)).toThrowError(
        "Expected string or Buffer for keyset, received null",
      );
      expect(() => parseKeysetJson(12345 as any)).toThrowError(
        "Expected string or Buffer for keyset, received number",
      );
      expect(() => parseKeysetJson(undefined as any)).toThrowError(
        "Expected string or Buffer for keyset, received undefined",
      );
    });

    it("enforces non-empty content check on trimmed input", () => {
      expect(() => parseKeysetJson("   \n\t  ")).toThrowError(KeysetParseError);
      expect(() => parseKeysetJson("   \n\t  ")).toThrowError(
        "Keyset content cannot be empty",
      );
      expect(() => parseKeysetJson(Buffer.from("   "))).toThrowError(
        "Keyset content cannot be empty",
      );
    });

    it("rejects reserved prototype identifiers lexically and via JSON reviver", () => {
      const lexicalPayload = '{"__proto__": {"polluted": true}}';
      expect(() => parseKeysetJson(lexicalPayload)).toThrowError(
        KeysetValidationError,
      );
      expect(() => parseKeysetJson(lexicalPayload)).toThrowError(
        "Keyset JSON contains forbidden reserved prototype identifier (__proto__, constructor, or prototype)",
      );

      const constructorPayload = '{"constructor": {}}';
      expect(() => parseKeysetJson(constructorPayload)).toThrowError(
        "Keyset JSON contains forbidden reserved prototype identifier (__proto__, constructor, or prototype)",
      );
    });

    it("wraps syntax error with KeysetParseError and preserves cause", () => {
      try {
        parseKeysetJson("{ not valid json }");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(KeysetParseError);
        expect((err as KeysetParseError).message).toContain(
          "Failed to parse keyset JSON",
        );
        expect((err as KeysetParseError).cause).toBeDefined();
      }
    });

    it("rejects non-object root JSON values", () => {
      expect(() => parseKeysetJson("[]")).toThrowError(
        "Keyset JSON root must be an object",
      );
      expect(() => parseKeysetJson("123")).toThrowError(
        "Keyset JSON root must be an object",
      );
      expect(() => parseKeysetJson('"string"')).toThrowError(
        "Keyset JSON root must be an object",
      );
      expect(() => parseKeysetJson("true")).toThrowError(
        "Keyset JSON root must be an object",
      );
    });

    it("rejects reserved kid names via reviver and invalid kid patterns", () => {
      // Unicode-escaped constructor bypasses lexical check and hits reviver
      const unicodeConstructor =
        '{"\\u0063onstructor": {"public_key": "' +
        hexPublicKey +
        '", "role": "operator"}}';
      expect(() => parseKeysetJson(unicodeConstructor)).toThrowError(
        'Keyset JSON contains forbidden reserved identifier: "constructor"',
      );

      const invalidKid = JSON.stringify({
        "bad kid with spaces!": { public_key: hexPublicKey, role: "operator" },
      });
      expect(() => parseKeysetJson(invalidKid)).toThrowError(
        /violates kid format requirements/,
      );
    });

    it("includes path and detail in schema validation errors", () => {
      const badSchema = JSON.stringify({
        "alice-key": { public_key: hexPublicKey, role: "invalid_role_name" },
      });
      try {
        parseKeysetJson(badSchema);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(KeysetValidationError);
        expect((err as Error).message).toContain(
          "Keyset failed schema validation: alice-key",
        );
      }
    });

    it("rejects invalid Ed25519 public key and sets cause", () => {
      const invalidKeyJson = JSON.stringify({
        "alice-key": {
          public_key: "not-a-valid-ed25519-key",
          role: "operator",
        },
      });
      try {
        parseKeysetJson(invalidKeyJson);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(KeysetValidationError);
        expect((err as Error).message).toContain(
          'Invalid Ed25519 public key for kid "alice-key"',
        );
        expect((err as KeysetValidationError).cause).toBeDefined();
      }
    });

    it("allows boundary ttl_seconds exactly equal to key.max_ttl_seconds", () => {
      const keyset = parseKeysetJson(
        JSON.stringify({
          "sre-alice": {
            public_key: hexPublicKey,
            role: "operator",
            max_ttl_seconds: 1800, // Exactly matches payload.ttl_seconds
          },
        }),
      );
      const envelope = signLease(validLeasePayload, privateKey);
      expect(verifyLeaseWithKeyset(envelope, keyset)).toBe(true);
    });

    it("fails closed in verifyLeaseWithKeyset when kid is missing or verification throws", () => {
      const keyset = parseKeysetJson(
        JSON.stringify({
          "other-key": {
            public_key: hexPublicKey,
            role: "operator",
          },
        }),
      );
      const envelope = signLease(validLeasePayload, privateKey);
      // kid is sre-alice, not other-key
      expect(verifyLeaseWithKeyset(envelope, keyset)).toBe(false);
      // Malformed envelope causing throw
      expect(verifyLeaseWithKeyset(null as any, keyset)).toBe(false);
    });

    it("fails closed in verifyRevocationWithKeyset on unknown kid, unauthorized role, or error", () => {
      const keyset = parseKeysetJson(
        JSON.stringify({
          "sre-alice": {
            public_key: hexPublicKey,
            roles: ["key_revoker"], // Not a lease_signer
          },
        }),
      );
      const revPayload = {
        v: 1 as const,
        lease_id: validLeasePayload.lease_id,
        revoked_at: "2026-10-06T02:15:00.000Z",
        kid: "sre-alice",
        reason: "early",
      };
      const envelope = signRevocation(revPayload, privateKey);
      expect(verifyRevocationWithKeyset(envelope, keyset)).toBe(false);

      // Unknown kid
      const unknownEnv = signRevocation(
        { ...revPayload, kid: "unknown-kid" },
        privateKey,
      );
      expect(verifyRevocationWithKeyset(unknownEnv, keyset)).toBe(false);

      // Null envelope
      expect(verifyRevocationWithKeyset(null as any, keyset)).toBe(false);
    });

    it("fails closed in verifyKeyRevocationWithKeyset on missing kid, unknown kid, unauthorized role, or error", () => {
      const keyset = parseKeysetJson(
        JSON.stringify({
          "sre-alice": {
            public_key: hexPublicKey,
            roles: ["lease_signer"], // Not a key_revoker
          },
        }),
      );
      const keyRevPayload = {
        v: 1 as const,
        kid: "compromised-key",
        revoked_at: "2026-10-06T02:30:00.000Z",
        revoked_by_kid: "sre-alice",
        reason: "Lost",
      };
      const envelope = signKeyRevocation(keyRevPayload, privateKey);
      // sre-alice lacks key_revoker role
      expect(verifyKeyRevocationWithKeyset(envelope, keyset)).toBe(false);

      // Unknown kid
      const unknownEnv = signKeyRevocation(
        { ...keyRevPayload, revoked_by_kid: "unknown-admin" },
        privateKey,
      );
      expect(verifyKeyRevocationWithKeyset(unknownEnv, keyset)).toBe(false);

      // Missing revoked_by_kid and no signerKid passed
      const missingKidEnv = signKeyRevocation(
        { ...keyRevPayload, revoked_by_kid: "" },
        privateKey,
      );
      expect(verifyKeyRevocationWithKeyset(missingKidEnv, keyset)).toBe(false);

      // Null envelope
      expect(verifyKeyRevocationWithKeyset(null as any, keyset)).toBe(false);
    });
  });
});
