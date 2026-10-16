import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  CHECKPOINT_DOMAIN_PREFIX,
  CheckpointPayloadSchema,
  CheckpointEnvelopeSchema,
  type CheckpointPayload,
  type CheckpointEnvelope,
  signCheckpoint,
  verifyCheckpoint,
  signCheckpointWithSigner,
  verifyCheckpointWithKeyset,
  canSignCheckpoint,
  parseKeysetJson,
} from "./index.js";

describe("Phase 4 PR 19: Checkpoint Data Model & Cryptography (packages/lease)", () => {
  // Generate test Ed25519 keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32);
  const hexPublicKey = rawPublicKey.toString("hex");

  const validPayload: CheckpointPayload = {
    v: 1,
    checkpoint_seq: 1042,
    checkpoint_hash: "a".repeat(64),
    timestamp: "2026-10-16T22:45:00.000Z",
    sealed_count: 1042,
    kid: "audit-signer-2026-01",
  };

  describe("Schema Validation (CheckpointPayloadSchema & CheckpointEnvelopeSchema)", () => {
    it("accepts a valid checkpoint payload", () => {
      const parsed = CheckpointPayloadSchema.parse(validPayload);
      expect(parsed).toEqual(validPayload);
    });

    it("rejects invalid version", () => {
      expect(() =>
        CheckpointPayloadSchema.parse({ ...validPayload, v: 2 }),
      ).toThrow();
    });

    it("rejects non-hex or invalid length checkpoint_hash", () => {
      expect(() =>
        CheckpointPayloadSchema.parse({
          ...validPayload,
          checkpoint_hash: "not-a-hex",
        }),
      ).toThrow();
      expect(() =>
        CheckpointPayloadSchema.parse({
          ...validPayload,
          checkpoint_hash: "a".repeat(63),
        }),
      ).toThrow();
      expect(() =>
        CheckpointPayloadSchema.parse({
          ...validPayload,
          checkpoint_hash: "Z".repeat(64),
        }),
      ).toThrow();
    });

    it("rejects negative checkpoint_seq or sealed_count", () => {
      expect(() =>
        CheckpointPayloadSchema.parse({
          ...validPayload,
          checkpoint_seq: -1,
        }),
      ).toThrow();
      expect(() =>
        CheckpointPayloadSchema.parse({
          ...validPayload,
          sealed_count: -1,
        }),
      ).toThrow();
    });

    it("rejects invalid timestamp format", () => {
      expect(() =>
        CheckpointPayloadSchema.parse({
          ...validPayload,
          timestamp: "not-a-date",
        }),
      ).toThrow();
    });

    it("rejects invalid or reserved kid", () => {
      expect(() =>
        CheckpointPayloadSchema.parse({
          ...validPayload,
          kid: "__proto__",
        }),
      ).toThrow();
      expect(() =>
        CheckpointPayloadSchema.parse({
          ...validPayload,
          kid: "",
        }),
      ).toThrow();
    });
  });

  describe("Cryptographic Domain Separation & Envelope", () => {
    it("defines CHECKPOINT_DOMAIN_PREFIX as synapsestate/checkpoint/v1\\n", () => {
      expect(CHECKPOINT_DOMAIN_PREFIX).toBe("synapsestate/checkpoint/v1\n");
    });
  });

  describe("Signing and Verification (signCheckpoint & verifyCheckpoint)", () => {
    it("signs and verifies a checkpoint envelope with Ed25519 keypair", async () => {
      const envelope = await signCheckpoint(validPayload, privateKey);
      expect(envelope.payload).toEqual(validPayload);
      expect(envelope.sig).toBeDefined();
      expect(typeof envelope.sig).toBe("string");
      expect(envelope.sig.length).toBeGreaterThan(0);

      // Verify envelope against schema
      const parsedEnvelope = CheckpointEnvelopeSchema.parse(envelope);
      expect(parsedEnvelope).toEqual(envelope);

      // Cryptographic verification
      const isValid = verifyCheckpoint(envelope, publicKey);
      expect(isValid).toBe(true);

      // Verification with hex string public key
      const isValidHex = verifyCheckpoint(envelope, hexPublicKey);
      expect(isValidHex).toBe(true);
    });

    it("rejects verification if checkpoint payload is tampered", async () => {
      const envelope = await signCheckpoint(validPayload, privateKey);
      const tampered: CheckpointEnvelope = {
        payload: {
          ...envelope.payload,
          checkpoint_seq: 1043,
        },
        sig: envelope.sig,
      };

      const isValid = verifyCheckpoint(tampered, publicKey);
      expect(isValid).toBe(false);
    });

    it("rejects verification if signature is corrupted", async () => {
      const envelope = await signCheckpoint(validPayload, privateKey);
      const corrupted: CheckpointEnvelope = {
        payload: envelope.payload,
        sig: envelope.sig.slice(0, -4) + "AAAA",
      };

      const isValid = verifyCheckpoint(corrupted, publicKey);
      expect(isValid).toBe(false);
    });

    it("rejects verification with a different Ed25519 public key", async () => {
      const envelope = await signCheckpoint(validPayload, privateKey);
      const otherPair = crypto.generateKeyPairSync("ed25519");

      const isValid = verifyCheckpoint(envelope, otherPair.publicKey);
      expect(isValid).toBe(false);
    });
  });

  describe("Signer Abstraction (signCheckpointWithSigner)", () => {
    it("signs with an AsyncSigner / Signer interface", async () => {
      const mockSigner = {
        kid: validPayload.kid,
        sign: async (message: Uint8Array) => {
          const sigBuf = crypto.sign(null, Buffer.from(message), privateKey);
          return sigBuf.toString("base64url");
        },
      };

      const envelope = await signCheckpointWithSigner(validPayload, mockSigner);
      expect(envelope.payload).toEqual(validPayload);
      expect(verifyCheckpoint(envelope, publicKey)).toBe(true);
    });

    it("throws if signer.kid does not match payload.kid", async () => {
      const mockSigner = {
        kid: "different-kid",
        sign: async () => "sig",
      };

      await expect(
        signCheckpointWithSigner(validPayload, mockSigner),
      ).rejects.toThrow(/Signer kid "different-kid" does not match/);
    });
  });

  describe("Keyset Integration (verifyCheckpointWithKeyset & canSignCheckpoint)", () => {
    const keysetJson = JSON.stringify({
      "audit-signer-2026-01": {
        public_key: hexPublicKey,
        roles: ["checkpoint_signer"],
        status: "active",
      },
      "audit-reader-key": {
        public_key: hexPublicKey,
        roles: ["operator"],
        status: "active",
      },
      "revoked-signer-key": {
        public_key: hexPublicKey,
        roles: ["audit_signer"],
        status: "revoked",
      },
      "admin-key": {
        public_key: hexPublicKey,
        role: "admin",
        status: "active",
      },
    });

    const keyset = parseKeysetJson(keysetJson);

    it("authorizes keys with checkpoint_signer, audit_signer, or admin role", () => {
      const checkpointKey = keyset["audit-signer-2026-01"]!;
      const operatorKey = keyset["audit-reader-key"]!;
      const revokedKey = keyset["revoked-signer-key"]!;
      const adminKey = keyset["admin-key"]!;

      expect(canSignCheckpoint(checkpointKey)).toBe(true);
      expect(canSignCheckpoint(adminKey)).toBe(true);
      expect(canSignCheckpoint(operatorKey)).toBe(false);
      expect(canSignCheckpoint(revokedKey)).toBe(false);
    });

    it("verifies checkpoint against trusted keyset successfully", async () => {
      const envelope = await signCheckpoint(validPayload, privateKey);
      const isValid = verifyCheckpointWithKeyset(envelope, keyset);
      expect(isValid).toBe(true);
    });

    it("verifies checkpoint signed by an admin key", async () => {
      const adminPayload: CheckpointPayload = {
        ...validPayload,
        kid: "admin-key",
      };
      const envelope = await signCheckpoint(adminPayload, privateKey);
      const isValid = verifyCheckpointWithKeyset(envelope, keyset);
      expect(isValid).toBe(true);
    });

    it("fails verification if kid is not in keyset", async () => {
      const unknownPayload: CheckpointPayload = {
        ...validPayload,
        kid: "unknown-kid",
      };
      const envelope = await signCheckpoint(unknownPayload, privateKey);
      const isValid = verifyCheckpointWithKeyset(envelope, keyset);
      expect(isValid).toBe(false);
    });

    it("fails verification if key is revoked", async () => {
      const revokedPayload: CheckpointPayload = {
        ...validPayload,
        kid: "revoked-signer-key",
      };
      const envelope = await signCheckpoint(revokedPayload, privateKey);
      const isValid = verifyCheckpointWithKeyset(envelope, keyset);
      expect(isValid).toBe(false);
    });

    it("fails verification if key lacks checkpoint signing role", async () => {
      const operatorPayload: CheckpointPayload = {
        ...validPayload,
        kid: "audit-reader-key",
      };
      const envelope = await signCheckpoint(operatorPayload, privateKey);
      const isValid = verifyCheckpointWithKeyset(envelope, keyset);
      expect(isValid).toBe(false);
    });
  });
});
