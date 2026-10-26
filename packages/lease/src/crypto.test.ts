import { describe, it, expect } from "vitest";
import fc from "fast-check";
import crypto from "node:crypto";
import {
  signLease,
  verifyLease,
  signRevocation,
  verifyRevocation,
  signKeyRevocation,
  verifyKeyRevocation,
  signLeaseWithSigner,
  signRevocationWithSigner,
  formatPublicKeyToHex,
  formatPublicKeyToBase64Url,
  resolvePublicKey,
  resolvePrivateKey,
} from "./crypto.js";
import type {
  LeasePayload,
  RevocationPayload,
  KeyRevocationPayload,
} from "./schema.js";

describe("Ed25519 Cryptographic Sign & Verify", () => {
  // Generate a test Ed25519 keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const { publicKey: otherPublicKey } = crypto.generateKeyPairSync("ed25519");

  const sampleLease: LeasePayload = {
    v: 1,
    lease_id: "01J9X57YTRPQ8A7F4E12345678",
    env: "prod",
    flag_key: "killswitch-cart",
    value: true,
    reason: "INC-999: Emergency killswitch",
    issued_at: "2026-10-06T02:14:00.000Z",
    ttl_seconds: 900,
    kid: "sre-alice",
    nonce: "YWJjZGVmZ2hpams",
  };

  const sampleRevocation: RevocationPayload = {
    v: 1,
    lease_id: "01J9X57YTRPQ8A7F4E12345678",
    revoked_at: "2026-10-06T02:20:00.000Z",
    kid: "sre-alice",
    reason: "Resolved",
  };

  const sampleKeyRevocation: KeyRevocationPayload = {
    v: 1,
    kid: "compromised-key",
    revoked_at: "2026-10-06T02:22:00.000Z",
    revoked_by_kid: "security-lead",
    reason: "Device lost",
  };

  describe("signLease & verifyLease", () => {
    it("signs and verifies a lease payload", () => {
      const envelope = signLease(sampleLease, privateKey);
      expect(envelope.payload).toEqual(sampleLease);
      expect(typeof envelope.sig).toBe("string");
      expect(envelope.sig.length).toBe(86); // 64 raw bytes base64url encoded

      const isValid = verifyLease(envelope, publicKey);
      expect(isValid).toBe(true);
    });

    it("verifies with multiple public key representations (KeyObject, PEM, hex, base64url, DER, raw)", () => {
      const envelope = signLease(sampleLease, privateKey);

      // KeyObject
      expect(verifyLease(envelope, publicKey)).toBe(true);

      // PEM
      const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
      expect(verifyLease(envelope, pem)).toBe(true);

      // Raw hex
      const rawHex = formatPublicKeyToHex(publicKey);
      expect(rawHex.length).toBe(64);
      expect(verifyLease(envelope, rawHex)).toBe(true);

      // Raw base64url
      const rawB64u = formatPublicKeyToBase64Url(publicKey);
      expect(rawB64u.length).toBe(43);
      expect(verifyLease(envelope, rawB64u)).toBe(true);

      // SPKI DER Buffer
      const der = publicKey.export({ type: "spki", format: "der" });
      expect(verifyLease(envelope, der)).toBe(true);

      // Raw 32-byte Buffer
      const rawBuf = Buffer.from(rawHex, "hex");
      expect(rawBuf.length).toBe(32);
      expect(verifyLease(envelope, rawBuf)).toBe(true);
    });

    it("rejects verification if payload content is altered", () => {
      const envelope = signLease(sampleLease, privateKey);

      // Alter value
      const alteredValue = {
        ...envelope,
        payload: { ...envelope.payload, value: false },
      };
      expect(verifyLease(alteredValue, publicKey)).toBe(false);

      // Alter ttl_seconds
      const alteredTtl = {
        ...envelope,
        payload: { ...envelope.payload, ttl_seconds: 1800 },
      };
      expect(verifyLease(alteredTtl, publicKey)).toBe(false);

      // Alter flag_key
      const alteredFlag = {
        ...envelope,
        payload: { ...envelope.payload, flag_key: "other-flag" },
      };
      expect(verifyLease(alteredFlag, publicKey)).toBe(false);
    });

    it("rejects verification with wrong public key", () => {
      const envelope = signLease(sampleLease, privateKey);
      expect(verifyLease(envelope, otherPublicKey)).toBe(false);
    });

    it("rejects verification if signature is corrupted or tampered", () => {
      const envelope = signLease(sampleLease, privateKey);
      const corruptedSig =
        (envelope.sig[0] === "A" ? "B" : "A") + envelope.sig.slice(1);
      expect(verifyLease({ ...envelope, sig: corruptedSig }, publicKey)).toBe(
        false,
      );

      const corruptedEndSig =
        envelope.sig.slice(0, -1) + (envelope.sig.endsWith("A") ? "B" : "A");
      expect(
        verifyLease({ ...envelope, sig: corruptedEndSig }, publicKey),
      ).toBe(false);

      // Truncated signature
      expect(verifyLease({ ...envelope, sig: "dG9vc2hvcnQ" }, publicKey)).toBe(
        false,
      );
      // Empty signature
      expect(verifyLease({ ...envelope, sig: "" }, publicKey)).toBe(false);
      // Malformed characters
      expect(
        verifyLease(
          { ...envelope, sig: "invalid+base64/characters==" },
          publicKey,
        ),
      ).toBe(false);
    });

    it("fails closed on invalid key format without throwing", () => {
      const envelope = signLease(sampleLease, privateKey);
      expect(verifyLease(envelope, "not-a-valid-key")).toBe(false);
      expect(verifyLease(envelope, "")).toBe(false);
      expect(verifyLease(envelope, Buffer.from("short"))).toBe(false);
    });
  });

  describe("signRevocation & verifyRevocation", () => {
    it("signs and verifies a revocation envelope with REVOCATION_DOMAIN_PREFIX", () => {
      const envelope = signRevocation(sampleRevocation, privateKey);
      expect(verifyRevocation(envelope, publicKey)).toBe(true);
    });

    it("enforces domain separation: cross-verification with verifyLease fails", () => {
      const revEnvelope = signRevocation(sampleRevocation, privateKey);
      // Trying to verify a revocation envelope as a lease must fail due to domain separation prefix
      const fakeLeaseEnvelope = {
        payload: {
          ...sampleLease,
          lease_id: sampleRevocation.lease_id,
        },
        sig: revEnvelope.sig,
      };
      expect(verifyLease(fakeLeaseEnvelope, publicKey)).toBe(false);
    });

    it("rejects tampered revocation payload", () => {
      const envelope = signRevocation(sampleRevocation, privateKey);
      const tampered = {
        ...envelope,
        payload: { ...envelope.payload, reason: "tampered reason" },
      };
      expect(verifyRevocation(tampered, publicKey)).toBe(false);
    });
  });

  describe("signKeyRevocation & verifyKeyRevocation", () => {
    it("signs and verifies a key revocation envelope with KEYREVOCATION_DOMAIN_PREFIX", () => {
      const envelope = signKeyRevocation(sampleKeyRevocation, privateKey);
      expect(verifyKeyRevocation(envelope, publicKey)).toBe(true);
    });

    it("rejects tampered key revocation", () => {
      const envelope = signKeyRevocation(sampleKeyRevocation, privateKey);
      const tampered = {
        ...envelope,
        payload: { ...envelope.payload, kid: "other-kid" },
      };
      expect(verifyKeyRevocation(tampered, publicKey)).toBe(false);
    });
  });

  describe("signLeaseWithSigner & signRevocationWithSigner", () => {
    it("delegates to AsyncSigner and verifies successfully against standard verifiers", async () => {
      const mockSigner = {
        async sign(message: Uint8Array): Promise<string> {
          const sig = crypto.sign(null, Buffer.from(message), privateKey);
          return sig.toString("base64url");
        },
      };

      const leaseEnv = await signLeaseWithSigner(sampleLease, mockSigner);
      expect(verifyLease(leaseEnv, publicKey)).toBe(true);

      const revEnv = await signRevocationWithSigner(
        sampleRevocation,
        mockSigner,
      );
      expect(verifyRevocation(revEnv, publicKey)).toBe(true);
    });
  });

  describe("Property-based testing (fast-check)", () => {
    it("round-trip sign and verify holds for arbitrary valid lease payloads", () => {
      const leaseArbitrary = fc.record({
        v: fc.constant(1 as const),
        lease_id: fc.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
        env: fc.constantFrom("prod", "staging", "dev"),
        flag_key: fc.stringMatching(/^[a-z0-9]([-a-z0-9]{0,20}[a-z0-9])?$/),
        value: fc.oneof(
          fc.boolean(),
          fc.string(),
          fc.integer(),
          fc.record({
            enabled: fc.boolean(),
            count: fc.integer(),
            tag: fc.string(),
          }),
        ),
        reason: fc.string({ minLength: 1, maxLength: 50 }),
        issued_at: fc.constant("2026-10-06T02:14:00.000Z"),
        ttl_seconds: fc.integer({ min: 1, max: 86400 }),
        kid: fc.string({ minLength: 1, maxLength: 20 }),
        nonce: fc.string({ minLength: 1, maxLength: 30 }),
      });

      fc.assert(
        fc.property(leaseArbitrary, (payload) => {
          const envelope = signLease(payload, privateKey);
          return verifyLease(envelope, publicKey);
        }),
        { numRuns: 50 },
      );
    });

    it("corrupting any single character in a valid signature always fails verification", () => {
      const envelope = signLease(sampleLease, privateKey);

      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: envelope.sig.length - 1 }),
          fc.constantFrom("A", "B", "C", "D", "0", "1", "-", "_"),
          (index, replacementChar) => {
            const originalChar = envelope.sig[index];
            if (originalChar === replacementChar) {
              return true; // skip identical replacement
            }
            const corruptedSig =
              envelope.sig.slice(0, index) +
              replacementChar +
              envelope.sig.slice(index + 1);
            return (
              verifyLease({ ...envelope, sig: corruptedSig }, publicKey) ===
              false
            );
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe("resolvePublicKey and resolvePrivateKey normalization & errors", () => {
    it("normalizes public keys across formats: 88-char hex, 44-byte base64url, and 44-byte buffer", () => {
      const der = publicKey.export({ type: "spki", format: "der" });
      expect(der.length).toBe(44);

      const derHex88 = der.toString("hex");
      expect(derHex88.length).toBe(88);
      const kHex = resolvePublicKey(derHex88);
      expect(kHex.asymmetricKeyType).toBe("ed25519");

      const derB64u = der.toString("base64url");
      const kB64u = resolvePublicKey(derB64u);
      expect(kB64u.asymmetricKeyType).toBe("ed25519");

      const kDerBuf = resolvePublicKey(der);
      expect(kDerBuf.asymmetricKeyType).toBe("ed25519");
    });

    it("normalizes private keys across formats: KeyObject, PEM, raw hex 64, PKCS8 hex 96, base64url 43, PKCS8 base64url 48, buffer 32, buffer 48", () => {
      // KeyObject
      expect(resolvePrivateKey(privateKey).asymmetricKeyType).toBe("ed25519");

      // PEM
      const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      expect(resolvePrivateKey(pem).asymmetricKeyType).toBe("ed25519");

      // PKCS8 DER
      const pkcs8Der = privateKey.export({ type: "pkcs8", format: "der" });
      expect(pkcs8Der.length).toBe(48);

      // PKCS8 hex (96 chars)
      const pkcs8Hex96 = pkcs8Der.toString("hex");
      expect(pkcs8Hex96.length).toBe(96);
      expect(resolvePrivateKey(pkcs8Hex96).asymmetricKeyType).toBe("ed25519");

      // Raw hex (64 chars, 32 bytes)
      const rawPrivBytes = pkcs8Der.subarray(16);
      expect(rawPrivBytes.length).toBe(32);
      const rawHex64 = rawPrivBytes.toString("hex");
      expect(rawHex64.length).toBe(64);
      expect(resolvePrivateKey(rawHex64).asymmetricKeyType).toBe("ed25519");

      // Raw base64url (43 chars)
      const rawB64u43 = rawPrivBytes.toString("base64url");
      expect(rawB64u43.length).toBe(43);
      expect(resolvePrivateKey(rawB64u43).asymmetricKeyType).toBe("ed25519");

      // PKCS8 base64url (48 raw bytes)
      const pkcs8B64u = pkcs8Der.toString("base64url");
      expect(resolvePrivateKey(pkcs8B64u).asymmetricKeyType).toBe("ed25519");

      // Buffer 32
      expect(resolvePrivateKey(rawPrivBytes).asymmetricKeyType).toBe("ed25519");

      // Buffer 48
      expect(resolvePrivateKey(pkcs8Der).asymmetricKeyType).toBe("ed25519");
    });

    it("rejects non-ed25519 keys or invalid types", () => {
      // RSA Keypair
      const rsaPair = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });

      expect(() => resolvePublicKey(rsaPair.publicKey)).toThrowError(
        /Expected ed25519 public key, got rsa/,
      );
      expect(() => resolvePrivateKey(rsaPair.privateKey)).toThrowError(
        /Expected ed25519 private key, got rsa/,
      );

      const rsaPubPem = rsaPair.publicKey.export({
        type: "spki",
        format: "pem",
      }) as string;
      expect(() => resolvePublicKey(rsaPubPem)).toThrowError(
        /Expected ed25519 PEM key, got rsa/,
      );

      const rsaPrivPem = rsaPair.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }) as string;
      expect(() => resolvePrivateKey(rsaPrivPem)).toThrowError(
        /Expected ed25519 PEM key, got rsa/,
      );

      // Unsupported types
      expect(() => resolvePublicKey(12345 as any)).toThrowError(
        "Unsupported public key input type",
      );
      expect(() => resolvePrivateKey(12345 as any)).toThrowError(
        "Unsupported private key input type",
      );

      // Generic string / buffer invalid
      expect(() => resolvePublicKey("invalid-key-string")).toThrow();
      expect(() => resolvePrivateKey("invalid-key-string")).toThrow();

      // DER buffer for non-ed25519 keys
      const rsaSpkiDer = rsaPair.publicKey.export({
        type: "spki",
        format: "der",
      });
      const rsaPkcs8Der = rsaPair.privateKey.export({
        type: "pkcs8",
        format: "der",
      });
      expect(() => resolvePublicKey(rsaSpkiDer)).toThrowError(
        /Expected ed25519 key, got rsa/,
      );
      expect(() => resolvePrivateKey(rsaPkcs8Der)).toThrowError(
        /Expected ed25519 key, got rsa/,
      );

      // Generic string (PKCS#1) for non-ed25519
      const rsaPkcs1Pem = rsaPair.publicKey.export({
        type: "pkcs1",
        format: "pem",
      }) as string;
      expect(() => resolvePublicKey(rsaPkcs1Pem)).toThrowError(
        /Expected ed25519/,
      );
    });

    it("fails closed in verifyEnvelope on malformed envelopes and signatures", () => {
      expect(verifyLease(null as any, publicKey)).toBe(false);
      expect(verifyLease(undefined as any, publicKey)).toBe(false);
      expect(verifyLease("string" as any, publicKey)).toBe(false);
      expect(verifyLease({ payload: sampleLease } as any, publicKey)).toBe(
        false,
      );
      expect(
        verifyLease({ payload: sampleLease, sig: 1234 } as any, publicKey),
      ).toBe(false);

      // Non-canonical base64url (padding or invalid chars)
      expect(
        verifyLease({ payload: sampleLease, sig: "ABCDEF==" }, publicKey),
      ).toBe(false);

      // Signature not exactly 64 bytes
      const shortSig = Buffer.from("short").toString("base64url");
      expect(
        verifyLease({ payload: sampleLease, sig: shortSig }, publicKey),
      ).toBe(false);

      // Non-matching base64url roundtrip (malleable representation)
      const validEnvelope = signLease(sampleLease, privateKey);
      const rawSig = Buffer.from(validEnvelope.sig, "base64url");
      // Add extra padding or non-canonical characters
      const nonCanonical = rawSig.toString("base64url") + "%";
      expect(
        verifyLease({ payload: sampleLease, sig: nonCanonical }, publicKey),
      ).toBe(false);

      // Standard base64 with padding (fails BASE64URL_REGEX and roundtrip check)
      const standardBase64WithPadding = rawSig.toString("base64");
      expect(
        verifyLease(
          { payload: sampleLease, sig: standardBase64WithPadding },
          publicKey,
        ),
      ).toBe(false);

      // Signature buffer of wrong length (e.g. 63 bytes or 65 bytes)
      const wrongLenSig = Buffer.alloc(63, 0xaa).toString("base64url");
      expect(
        verifyLease({ payload: sampleLease, sig: wrongLenSig }, publicKey),
      ).toBe(false);

      const wrongLenSig65 = Buffer.alloc(65, 0xaa).toString("base64url");
      expect(
        verifyLease({ payload: sampleLease, sig: wrongLenSig65 }, publicKey),
      ).toBe(false);
    });
  });
});
