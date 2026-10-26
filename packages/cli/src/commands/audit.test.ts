import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type pg from "pg";
import {
  executeAuditVerify,
  executeAuditCheckpoint,
  registerAuditCommands,
} from "./audit.js";
import {
  GENESIS_PREV_HASH,
  computeEventHash,
  signCheckpoint,
  type AuditEventRecord,
  type CheckpointPayload,
} from "@synapsestate/lease";
import { Command } from "commander";

describe("Phase 4 PR 19: Audit Commands (packages/cli/src/commands/audit.ts)", () => {
  let tmpDir: string;
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const hexPublicKey = keyPair.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("hex");
  const hexPrivateKey = keyPair.privateKey
    .export({ type: "pkcs8", format: "der" })
    .subarray(-32)
    .toString("hex");

  const kid = "audit-signer-2026";
  let keysetPath: string;

  function createSealedChain(count: number): AuditEventRecord[] {
    const events: AuditEventRecord[] = [];
    let prevHash = GENESIS_PREV_HASH;
    for (let i = 1; i <= count; i++) {
      const ts = new Date(1700000000000 + i * 1000).toISOString();
      const eventData = {
        seq: i,
        ts,
        actor: `operator-${i}`,
        event_type: "LEASE_CREATED",
        payload: { flag: `flag-${i}`, value: true },
      };
      const hash = computeEventHash(prevHash, eventData);
      const record: AuditEventRecord = {
        ...eventData,
        prev_hash: prevHash,
        hash,
      };
      events.push(record);
      prevHash = hash;
    }
    return events;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-cli-test-"));
    keysetPath = path.join(tmpDir, "keyset.json");
    await fs.writeFile(
      keysetPath,
      JSON.stringify({
        [kid]: {
          public_key: hexPublicKey,
          roles: ["checkpoint_signer"],
          status: "active",
        },
      }),
    );
  });

  describe("synapse audit verify", () => {
    it("verifies a valid ledger chain from a JSON file", async () => {
      const events = createSealedChain(5);
      const filePath = path.join(tmpDir, "audit.json");
      await fs.writeFile(filePath, JSON.stringify(events));

      const result = await executeAuditVerify({
        file: filePath,
        keyset: keysetPath,
      });

      expect(result.valid).toBe(true);
      expect(result.verifiedCount).toBe(5);
      expect(result.fromSeq).toBe(1);
      expect(result.toSeq).toBe(5);
      expect(result.genesisPrevHash).toBe(GENESIS_PREV_HASH);
      expect(result.latestHash).toBe(events[4]!.hash);
      expect(result.checkpoint?.status).toBe("NO_CHECKPOINT");
      expect(result.formattedOutput).toContain(
        "AUDIT LEDGER VERIFICATION: PASSED",
      );
    });

    it("verifies a valid ledger chain from a JSONL file", async () => {
      const events = createSealedChain(3);
      const filePath = path.join(tmpDir, "audit.jsonl");
      const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
      await fs.writeFile(filePath, jsonl);

      const result = await executeAuditVerify({
        file: filePath,
        keyset: keysetPath,
      });

      expect(result.valid).toBe(true);
      expect(result.verifiedCount).toBe(3);
    });

    it("detects payload tampering (SHA-256 hash mismatch)", async () => {
      const events = createSealedChain(5);
      // Corrupt payload at seq 3
      (events[2]!.payload as { flag: string }).flag = "tampered-flag";

      const filePath = path.join(tmpDir, "audit-tampered.json");
      await fs.writeFile(filePath, JSON.stringify(events));

      const result = await executeAuditVerify({
        file: filePath,
      });

      expect(result.valid).toBe(false);
      expect(result.failedSeq).toBe(3);
      expect(result.error).toContain("Hash mismatch at seq 3");
      expect(result.formattedOutput).toContain("FAILED");
    });

    it("detects broken prev_hash link", async () => {
      const events = createSealedChain(5);
      // Corrupt prev_hash at seq 4
      events[3]!.prev_hash = "f".repeat(64);

      const filePath = path.join(tmpDir, "audit-broken-link.json");
      await fs.writeFile(filePath, JSON.stringify(events));

      const result = await executeAuditVerify({
        file: filePath,
      });

      expect(result.valid).toBe(false);
      expect(result.failedSeq).toBe(4);
      expect(result.error).toContain("Broken prev_hash link at seq 4");
    });

    it("detects sequence discontinuity (missing/skipped record) and reports missing seq (I7)", async () => {
      const events = createSealedChain(5);
      // Remove event at index 2 (seq 3)
      events.splice(2, 1);

      const filePath = path.join(tmpDir, "audit-gap.json");
      await fs.writeFile(filePath, JSON.stringify(events));

      const result = await executeAuditVerify({
        file: filePath,
      });

      expect(result.valid).toBe(false);
      expect(result.failedSeq).toBe(3);
      expect(result.error).toContain(
        "Sequence discontinuity at index 2: expected seq 3, got 4",
      );
    });

    it("rejects prefix-truncated ledger starting at seq > 1 from genesis (C1)", async () => {
      const fullEvents = createSealedChain(10);
      // Drop first 4 events (keep seq 5..10)
      const truncated = fullEvents.slice(4);
      const filePath = path.join(tmpDir, "audit-truncated.json");
      await fs.writeFile(filePath, JSON.stringify(truncated));

      const result = await executeAuditVerify({
        file: filePath,
      });

      expect(result.valid).toBe(false);
      expect(result.failedSeq).toBe(5);
      expect(result.error).toContain(
        "Ledger does not start at genesis: first seq is 5, expected 1",
      );
      expect(result.formattedOutput).toContain("FAILED");
    });

    it("handles empty ledger file with NO EVENTS warning (I7)", async () => {
      const filePath = path.join(tmpDir, "audit-empty.json");
      await fs.writeFile(filePath, "[]");

      const result = await executeAuditVerify({
        file: filePath,
      });

      expect(result.valid).toBe(true);
      expect(result.verifiedCount).toBe(0);
      expect(result.fromSeq).toBe(0);
      expect(result.toSeq).toBe(0);
      expect(result.formattedOutput).toContain("NO EVENTS");
    });

    it("rejects malformed checkpoint envelope with schema validation error (I3)", async () => {
      const events = createSealedChain(5);
      const filePath = path.join(tmpDir, "audit.json");
      await fs.writeFile(filePath, JSON.stringify(events));

      // Malformed checkpoint: missing required payload fields
      const badCheckpointPath = path.join(tmpDir, "bad-checkpoint.json");
      await fs.writeFile(
        badCheckpointPath,
        JSON.stringify({
          payload: { v: 1, checkpoint_seq: "not-a-number" },
          sig: "invalid-sig",
        }),
      );

      const result = await executeAuditVerify({
        file: filePath,
        checkpoint: badCheckpointPath,
        keyset: keysetPath,
      });

      expect(result.valid).toBe(false);
      expect(result.checkpoint?.status).toBe("INVALID_SIGNATURE");
      expect(result.checkpoint?.error).toContain(
        "Failed to validate checkpoint envelope schema",
      );
    });

    it("cross-verifies valid signed checkpoint matching latest sealed event", async () => {
      const events = createSealedChain(5);
      const filePath = path.join(tmpDir, "audit.json");
      await fs.writeFile(filePath, JSON.stringify(events));

      const checkpointPayload: CheckpointPayload = {
        v: 1,
        checkpoint_seq: 5,
        checkpoint_hash: events[4]!.hash,
        timestamp: new Date().toISOString(),
        sealed_count: 5,
        kid,
      };
      const envelope = signCheckpoint(checkpointPayload, keyPair.privateKey);
      const checkpointPath = path.join(tmpDir, "checkpoint.json");
      await fs.writeFile(checkpointPath, JSON.stringify(envelope));

      const result = await executeAuditVerify({
        file: filePath,
        checkpoint: checkpointPath,
        keyset: keysetPath,
      });

      expect(result.valid).toBe(true);
      expect(result.checkpoint?.status).toBe("VALIDATED");
      expect(result.checkpoint?.seq).toBe(5);
      expect(result.checkpoint?.hash).toBe(events[4]!.hash);
    });

    it("detects checkpoint hash mismatch with event chain", async () => {
      const events = createSealedChain(5);
      const filePath = path.join(tmpDir, "audit.json");
      await fs.writeFile(filePath, JSON.stringify(events));

      const checkpointPayload: CheckpointPayload = {
        v: 1,
        checkpoint_seq: 5,
        checkpoint_hash: "f".repeat(64), // Mismatched hash
        timestamp: new Date().toISOString(),
        sealed_count: 5,
        kid,
      };
      const envelope = signCheckpoint(checkpointPayload, keyPair.privateKey);
      const checkpointPath = path.join(tmpDir, "checkpoint-mismatch.json");
      await fs.writeFile(checkpointPath, JSON.stringify(envelope));

      const result = await executeAuditVerify({
        file: filePath,
        checkpoint: checkpointPath,
        keyset: keysetPath,
      });

      expect(result.valid).toBe(false);
      expect(result.checkpoint?.status).toBe("MISMATCH");
      expect(result.error).toContain("Checkpoint hash mismatch");
    });

    it("rejects checkpoint with invalid cryptographic signature", async () => {
      const events = createSealedChain(5);
      const filePath = path.join(tmpDir, "audit.json");
      await fs.writeFile(filePath, JSON.stringify(events));

      const checkpointPayload: CheckpointPayload = {
        v: 1,
        checkpoint_seq: 5,
        checkpoint_hash: events[4]!.hash,
        timestamp: new Date().toISOString(),
        sealed_count: 5,
        kid,
      };
      const otherKey = crypto.generateKeyPairSync("ed25519");
      const envelope = signCheckpoint(checkpointPayload, otherKey.privateKey);
      const checkpointPath = path.join(tmpDir, "checkpoint-bad-sig.json");
      await fs.writeFile(checkpointPath, JSON.stringify(envelope));

      const result = await executeAuditVerify({
        file: filePath,
        checkpoint: checkpointPath,
        keyset: keysetPath,
      });

      expect(result.valid).toBe(false);
      expect(result.checkpoint?.status).toBe("INVALID_SIGNATURE");
    });

    it("verifies audit events retrieved from Control API", async () => {
      const events = createSealedChain(3);
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/v1/audit/events")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              events,
              count: 3,
              total: 3,
              has_more: false,
            }),
          });
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      const result = await executeAuditVerify({
        apiUrl: "http://localhost:3000",
        token: "test-token",
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.valid).toBe(true);
      expect(result.verifiedCount).toBe(3);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/audit/events"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
    });

    it("verifies audit events retrieved directly from PostgreSQL connection", async () => {
      const events = createSealedChain(4);
      const mockQuery = vi.fn().mockResolvedValue({ rows: events });
      const mockPool = {
        query: mockQuery,
        end: vi.fn().mockResolvedValue(undefined),
      } as unknown as pg.Pool;

      const result = await executeAuditVerify({
        pgPool: mockPool,
      });

      expect(result.valid).toBe(true);
      expect(result.verifiedCount).toBe(4);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining(
          "SELECT seq, ts, actor, event_type, payload, prev_hash, hash FROM audit_events",
        ),
      );
    });
  });

  describe("synapse audit checkpoint", () => {
    it("creates, signs, and saves checkpoint to local file via API", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/v1/audit/checkpoint/latest")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              checkpoint_seq: 1042,
              checkpoint_hash: "a".repeat(64),
              sealed_count: 1042,
              timestamp: "2026-10-16T22:45:00.000Z",
            }),
          });
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      const outPath = path.join(tmpDir, "new-checkpoint.json");

      const result = await executeAuditCheckpoint({
        apiUrl: "http://localhost:3000",
        token: "operator-token",
        kid,
        key: hexPrivateKey,
        out: outPath,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.envelope.payload.checkpoint_seq).toBe(1042);
      expect(result.envelope.payload.checkpoint_hash).toBe("a".repeat(64));
      expect(result.envelope.payload.kid).toBe(kid);
      expect(result.savedTo).toContain(outPath);

      // Verify written file
      const savedRaw = await fs.readFile(outPath, "utf-8");
      const savedEnvelope = JSON.parse(savedRaw);
      expect(savedEnvelope.payload.checkpoint_seq).toBe(1042);
    });

    it("creates, signs, and uploads checkpoint to S3", async () => {
      const mockSend = vi.fn().mockResolvedValue({});
      const mockS3Client = { send: mockSend };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          checkpoint_seq: 50,
          checkpoint_hash: "b".repeat(64),
          sealed_count: 50,
          timestamp: "2026-10-16T23:00:00.000Z",
        }),
      });

      const result = await executeAuditCheckpoint({
        apiUrl: "http://localhost:3000",
        token: "operator-token",
        kid,
        key: hexPrivateKey,
        s3Bucket: "my-audit-bucket",
        s3Region: "us-west-2",
        s3Prefix: "audit-checkpoints",
        fetchFn: mockFetch as unknown as typeof fetch,
        s3Client: mockS3Client,
      });

      expect(result.envelope.payload.checkpoint_seq).toBe(50);
      expect(result.savedTo).toContain(
        "s3://my-audit-bucket/audit-checkpoints/50.json",
      );
      expect(result.savedTo).toContain(
        "s3://my-audit-bucket/audit-checkpoints/checkpoint-latest.json",
      );
      expect(mockSend).toHaveBeenCalledTimes(2);

      // Verify Invariant & ADR 0005: S3 PutObjectCommand includes ChecksumSHA256 (I5)
      const firstPutCmd = mockSend.mock.calls[0][0];
      expect(firstPutCmd.input.ChecksumSHA256).toBeDefined();
      expect(typeof firstPutCmd.input.ChecksumSHA256).toBe("string");
      const expectedChecksum = crypto
        .createHash("sha256")
        .update(JSON.stringify(result.envelope, null, 2))
        .digest("base64");
      expect(firstPutCmd.input.ChecksumSHA256).toBe(expectedChecksum);
    });

    it("refuses to sign genesis checkpoint when audit ledger is empty (I6)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          checkpoint_seq: 0,
          checkpoint_hash: GENESIS_PREV_HASH,
          sealed_count: 0,
          timestamp: null,
        }),
      });

      await expect(
        executeAuditCheckpoint({
          apiUrl: "http://localhost:3000",
          kid,
          key: hexPrivateKey,
          fetchFn: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(
        "Audit ledger is empty (no sealed events); refusing to sign genesis checkpoint. Seal at least one event first.",
      );
    });

    it("verifies kid and key match when trusted keyset is provided (I4)", async () => {
      const otherPair = crypto.generateKeyPairSync("ed25519");
      const otherHexPrivateKey = otherPair.privateKey
        .export({ type: "pkcs8", format: "der" })
        .subarray(-32)
        .toString("hex");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          checkpoint_seq: 10,
          checkpoint_hash: "d".repeat(64),
          sealed_count: 10,
          timestamp: "2026-10-16T23:45:00.000Z",
        }),
      });

      // Passing wrong key for kid with keyset loaded should throw key mismatch
      await expect(
        executeAuditCheckpoint({
          apiUrl: "http://localhost:3000",
          kid,
          key: otherHexPrivateKey,
          keyset: keysetPath,
          fetchFn: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(/does not match public key .* in keyset/);
    });

    it("normalizes base64url keyset public key and verifies match against derived key (O1)", async () => {
      const b64UrlPublicKey = Buffer.from(hexPublicKey, "hex").toString(
        "base64url",
      );
      const b64KeysetPath = path.join(tmpDir, "keyset-b64.json");
      await fs.writeFile(
        b64KeysetPath,
        JSON.stringify({
          [kid]: {
            public_key: b64UrlPublicKey,
            roles: ["checkpoint_signer"],
            status: "active",
          },
        }),
      );

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          checkpoint_seq: 15,
          checkpoint_hash: "e".repeat(64),
          sealed_count: 15,
          timestamp: "2026-10-16T23:50:00.000Z",
        }),
      });

      const result = await executeAuditCheckpoint({
        apiUrl: "http://localhost:3000",
        kid,
        key: hexPrivateKey,
        keyset: b64KeysetPath,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.envelope.payload.checkpoint_seq).toBe(15);
    });

    it("reads latest event directly from PostgreSQL if DB configured", async () => {
      const mockQuery = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return Promise.resolve({ rows: [{ count: "77" }] });
        }
        return Promise.resolve({
          rows: [
            {
              seq: "77",
              hash: "c".repeat(64),
              ts: new Date("2026-10-16T23:30:00.000Z"),
            },
          ],
        });
      });

      const mockPool = {
        query: mockQuery,
        end: vi.fn().mockResolvedValue(undefined),
      } as unknown as pg.Pool;

      const outPath = path.join(tmpDir, "db-checkpoint.json");

      const result = await executeAuditCheckpoint({
        pgPool: mockPool,
        kid,
        key: hexPrivateKey,
        out: outPath,
      });

      expect(result.envelope.payload.checkpoint_seq).toBe(77);
      expect(result.envelope.payload.checkpoint_hash).toBe("c".repeat(64));
      expect(result.envelope.payload.sealed_count).toBe(77);
    });
  });

  describe("Commander CLI Registration", () => {
    it("registers audit verify and audit checkpoint commands on program", () => {
      const program = new Command();
      registerAuditCommands(program);

      const auditCmd = program.commands.find((c) => c.name() === "audit");
      expect(auditCmd).toBeDefined();

      const verifyCmd = auditCmd?.commands.find((c) => c.name() === "verify");
      expect(verifyCmd).toBeDefined();

      const checkpointCmd = auditCmd?.commands.find(
        (c) => c.name() === "checkpoint",
      );
      expect(checkpointCmd).toBeDefined();
    });
  });
});
