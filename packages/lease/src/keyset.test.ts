import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  parseKeysetJson,
  getKey,
  hasKey,
  isKeyRevoked,
  KeysetParseError,
  KeysetValidationError,
} from "./keyset.js";
import { formatPublicKeyToHex } from "./crypto.js";
import type { KeyRevocationPayload } from "./schema.js";

describe("Keyset Parser & Validator", () => {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
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
    expect(aliceKey?.max_ttl_seconds).toBe(3600);
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
