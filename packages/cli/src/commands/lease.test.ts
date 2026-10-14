import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  verifyLease,
  verifyRevocationWithKeyset,
  parseKeysetJson,
  ULID_REGEX,
  type LeaseEnvelope,
  type RevocationEnvelope,
} from "@synapsestate/lease";
import { EncryptedKeyfileSigner } from "../signer/encrypted-file.js";
import {
  executeLeaseCreate,
  executeLeaseList,
  executeLeaseRevoke,
  executeLeaseEmergencyApply,
  parseOverrideValue,
  registerLeaseCommands,
} from "./lease.js";
import { Command } from "commander";

describe("Lease Lifecycle Commands (packages/cli/src/commands/lease.ts)", () => {
  let tmpDir: string;
  let testKid: string;
  let keyPassword: string;
  let keyFilePath: string;
  let publicKeyHex: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-cli-lease-test-"));
    testKid = "alice-oncall-sre";
    keyPassword = "test-strong-passphrase-123!";

    const gen = await EncryptedKeyfileSigner.generate({
      kid: testKid,
      password: keyPassword,
      outDir: tmpDir,
    });
    keyFilePath = gen.filePath;
    publicKeyHex = gen.publicKeyHex;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("parseOverrideValue", () => {
    it("parses booleans correctly", () => {
      expect(parseOverrideValue("true")).toBe(true);
      expect(parseOverrideValue("false")).toBe(false);
    });

    it("parses numbers correctly", () => {
      expect(parseOverrideValue("42")).toBe(42);
      expect(parseOverrideValue("-10.5")).toBe(-10.5);
    });

    it("parses JSON objects and arrays", () => {
      expect(parseOverrideValue('{"rate":0.5,"enabled":true}')).toEqual({
        rate: 0.5,
        enabled: true,
      });
      expect(parseOverrideValue("[1, 2, 3]")).toEqual([1, 2, 3]);
    });

    it("falls back to raw string for identifiers and strings", () => {
      expect(parseOverrideValue("blue")).toBe("blue");
      expect(parseOverrideValue("variant-a")).toBe("variant-a");
    });
  });

  describe("executeLeaseCreate", () => {
    it("creates, signs, and posts lease envelope with synchronized server time and rollout verification", async () => {
      const serverTimeIso = "2026-10-14T12:00:00.000Z";
      let postBody: LeaseEnvelope | undefined;
      let statePollCount = 0;

      const mockFetch: typeof fetch = vi.fn(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/v1/time")) {
          return new Response(JSON.stringify({ server_time: serverTimeIso }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/v1/leases") && method === "POST") {
          postBody = JSON.parse(String(init?.body)) as LeaseEnvelope;
          return new Response(
            JSON.stringify({
              lease_id: postBody.payload.lease_id,
              state: "ACTIVE",
              warnings: [],
            }),
            {
              status: 201,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.includes("/v1/sdk/state") || url.includes("/v1/state")) {
          statePollCount++;
          // First poll: empty; second poll: returns created lease in active_leases
          const activeLeases =
            statePollCount >= 2 && postBody ? [postBody] : [];
          return new Response(
            JSON.stringify({
              etag: "etag-123",
              server_time: new Date().toISOString(),
              registry_version: 1,
              active_leases: activeLeases,
              revocations: [],
              key_revocations: [],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      const result = await executeLeaseCreate({
        env: "production",
        flag: "checkout-v2",
        value: "false",
        reason: "INC-999: Database pool exhaustion",
        ttl: 1800,
        kid: testKid,
        keyFile: keyFilePath,
        password: keyPassword,
        apiUrl: "http://control-api.local",
        wait: true,
        timeoutSeconds: 5,
        pollIntervalMs: 10,
        fetchFn: mockFetch,
      });

      expect(result.leaseId).toMatch(ULID_REGEX);
      expect(result.envelope).toBeDefined();
      expect(result.envelope.payload.flag_key).toBe("checkout-v2");
      expect(result.envelope.payload.value).toBe(false);
      expect(result.envelope.payload.issued_at).toBe(serverTimeIso);
      expect(result.envelope.payload.ttl_seconds).toBe(1800);
      expect(result.envelope.payload.kid).toBe(testKid);

      // Verify cryptographic signature is valid with public key
      const verified = verifyLease(result.envelope, publicKeyHex);
      expect(verified).toBe(true);

      // Verify rollout polling occurred
      expect(statePollCount).toBeGreaterThanOrEqual(2);
      expect(result.rolloutConfirmed).toBe(true);
    });

    it("rejects invalid flag key format", async () => {
      await expect(
        executeLeaseCreate({
          env: "production",
          flag: "Invalid_Flag_Key!",
          value: "true",
          reason: "emergency fix",
          kid: testKid,
          keyFile: keyFilePath,
          password: keyPassword,
        }),
      ).rejects.toThrow(/flag_key/);
    });

    it("rejects out-of-range TTL values", async () => {
      await expect(
        executeLeaseCreate({
          env: "production",
          flag: "valid-flag",
          value: "true",
          reason: "emergency fix",
          ttl: 0,
          kid: testKid,
          keyFile: keyFilePath,
          password: keyPassword,
        }),
      ).rejects.toThrow(/ttl/i);

      await expect(
        executeLeaseCreate({
          env: "production",
          flag: "valid-flag",
          value: "true",
          reason: "emergency fix",
          ttl: 100000,
          kid: testKid,
          keyFile: keyFilePath,
          password: keyPassword,
        }),
      ).rejects.toThrow(/ttl/i);
    });

    it("rejects empty reason string", async () => {
      await expect(
        executeLeaseCreate({
          env: "production",
          flag: "valid-flag",
          value: "true",
          reason: "   ",
          kid: testKid,
          keyFile: keyFilePath,
          password: keyPassword,
        }),
      ).rejects.toThrow(/reason/i);
    });

    it("handles API error responses cleanly (e.g. 403 Forbidden or 409 Conflict)", async () => {
      const mockFetch: typeof fetch = vi.fn(async (input, _init) => {
        const url = String(input);
        if (url.endsWith("/v1/time")) {
          return new Response(
            JSON.stringify({ server_time: new Date().toISOString() }),
            { status: 200 },
          );
        }
        if (url.endsWith("/v1/leases")) {
          return new Response(
            JSON.stringify({
              error: 'Key "alice-oncall-sre" is not authorized to sign emergency leases',
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      await expect(
        executeLeaseCreate({
          env: "production",
          flag: "valid-flag",
          value: "true",
          reason: "testing error handling",
          kid: testKid,
          keyFile: keyFilePath,
          password: keyPassword,
          apiUrl: "http://control-api.local",
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow(/not authorized/);
    });

    it("skips rollout verification when wait is set to false", async () => {
      const mockFetch: typeof fetch = vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/time")) {
          return new Response(
            JSON.stringify({ server_time: new Date().toISOString() }),
            { status: 200 },
          );
        }
        if (url.endsWith("/v1/leases")) {
          return new Response(
            JSON.stringify({ lease_id: "01J9X57YTRPQ8A7F4E12345678", state: "ACTIVE" }),
            { status: 201 },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      const result = await executeLeaseCreate({
        env: "production",
        flag: "valid-flag",
        value: "true",
        reason: "no-wait test",
        kid: testKid,
        keyFile: keyFilePath,
        password: keyPassword,
        apiUrl: "http://control-api.local",
        wait: false,
        fetchFn: mockFetch,
      });

      expect(result.rolloutConfirmed).toBe(false);
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/v1/sdk/state"),
        expect.anything(),
      );
    });
  });

  describe("executeLeaseList", () => {
    it("fetches active leases from Control API and renders formatted table or JSON", async () => {
      const sampleEnvelope: LeaseEnvelope = {
        payload: {
          v: 1,
          lease_id: "01J9X57YTRPQ8A7F4E12345678",
          env: "production",
          flag_key: "checkout-v2",
          value: false,
          reason: "Database incident",
          issued_at: new Date(Date.now() - 60000).toISOString(),
          ttl_seconds: 1800,
          kid: testKid,
          nonce: "random-nonce-1234",
        },
        sig: "mock-sig",
      };

      const mockFetch: typeof fetch = vi.fn(async (input) => {
        const url = String(input);
        if (url.includes("/v1/sdk/state") || url.includes("/v1/state")) {
          return new Response(
            JSON.stringify({
              etag: "etag-abc",
              server_time: new Date().toISOString(),
              registry_version: 1,
              active_leases: [sampleEnvelope],
              revocations: [],
              key_revocations: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      // Test JSON format output
      const jsonOutput = await executeLeaseList({
        env: "production",
        json: true,
        apiUrl: "http://control-api.local",
        fetchFn: mockFetch,
      });
      const parsed = JSON.parse(jsonOutput);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].payload.lease_id).toBe("01J9X57YTRPQ8A7F4E12345678");

      // Test Table format output
      const tableOutput = await executeLeaseList({
        env: "production",
        json: false,
        apiUrl: "http://control-api.local",
        fetchFn: mockFetch,
      });
      expect(tableOutput).toContain("checkout-v2");
      expect(tableOutput).toContain("01J9X57YTRPQ8A7F4E12345678");
      expect(tableOutput).toContain(testKid);
    });

    it("reads active leases from offline emergency directory", async () => {
      const emergencyDir = path.join(tmpDir, "emergency-leases");
      await fs.mkdir(emergencyDir, { recursive: true });

      const sampleEnvelope: LeaseEnvelope = {
        payload: {
          v: 1,
          lease_id: "01J9X57YTRPQ8A7F4E12345678",
          env: "staging",
          flag_key: "payment-gateway",
          value: "stripe",
          reason: "Air-gapped override",
          issued_at: new Date().toISOString(),
          ttl_seconds: 3600,
          kid: testKid,
          nonce: "nonce-abc",
        },
        sig: "mock-sig",
      };

      await fs.writeFile(
        path.join(emergencyDir, `${sampleEnvelope.payload.lease_id}.json`),
        JSON.stringify(sampleEnvelope, null, 2),
      );

      const output = await executeLeaseList({
        offline: true,
        offlineDir: emergencyDir,
        env: "staging",
        json: true,
      });

      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].payload.flag_key).toBe("payment-gateway");
    });
  });

  describe("executeLeaseRevoke", () => {
    it("constructs, signs, and posts revocation envelope", async () => {
      const leaseId = "01J9X57YTRPQ8A7F4E12345678";
      let postedRevocation: RevocationEnvelope | undefined;

      const mockFetch: typeof fetch = vi.fn(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith(`/v1/leases/${leaseId}/revoke`) && method === "POST") {
          postedRevocation = JSON.parse(String(init?.body)) as RevocationEnvelope;
          return new Response(
            JSON.stringify({ lease_id: leaseId, state: "REVOKED" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      const result = await executeLeaseRevoke({
        id: leaseId,
        reason: "Incident resolved by upstream fix",
        kid: testKid,
        keyFile: keyFilePath,
        password: keyPassword,
        apiUrl: "http://control-api.local",
        fetchFn: mockFetch,
      });

      expect(result.leaseId).toBe(leaseId);
      expect(result.state).toBe("REVOKED");
      expect(postedRevocation).toBeDefined();
      expect(postedRevocation!.payload.lease_id).toBe(leaseId);
      expect(postedRevocation!.payload.kid).toBe(testKid);
      expect(postedRevocation!.payload.reason).toBe("Incident resolved by upstream fix");

      // Verify revocation signature
      const keyset = parseKeysetJson(
        JSON.stringify({
          [testKid]: {
            public_key: publicKeyHex,
            roles: ["lease_signer"],
            status: "active",
          },
        }),
      );
      const validSig = verifyRevocationWithKeyset(postedRevocation!, keyset);
      expect(validSig).toBe(true);
    });

    it("rejects invalid ULID for revocation id", async () => {
      await expect(
        executeLeaseRevoke({
          id: "invalid-id",
          reason: "valid reason",
          kid: testKid,
          keyFile: keyFilePath,
          password: keyPassword,
        }),
      ).rejects.toThrow(/lease_id/i);
    });
  });

  describe("executeLeaseEmergencyApply", () => {
    it("generates Kubernetes ConfigMap YAML and optionally writes to emergency dir", async () => {
      const emergencyDir = path.join(tmpDir, "k8s-emergency");

      const result = await executeLeaseEmergencyApply({
        env: "production",
        flag: "search-v3",
        value: '{"algo":"bm25"}',
        reason: "Air-gapped manual apply during Control API outage",
        ttl: 3600,
        kid: testKid,
        keyFile: keyFilePath,
        password: keyPassword,
        namespace: "synapse-system",
        apply: true,
        emergencyDir,
      });

      expect(result.envelope).toBeDefined();
      expect(result.envelope.payload.flag_key).toBe("search-v3");
      expect(result.envelope.payload.value).toEqual({ algo: "bm25" });

      // Verify cryptographic signature
      const verified = verifyLease(result.envelope, publicKeyHex);
      expect(verified).toBe(true);

      // Verify YAML formatting
      expect(result.yaml).toContain("kind: ConfigMap");
      expect(result.yaml).toContain("synapse-emergency-lease-");
      expect(result.yaml).toContain("namespace: synapse-system");
      expect(result.yaml).toContain(`${result.envelope.payload.lease_id}.json:`);

      // Verify file written to emergency directory
      const writtenFilePath = path.join(
        emergencyDir,
        `${result.envelope.payload.lease_id}.json`,
      );
      const fileContent = await fs.readFile(writtenFilePath, "utf8");
      const parsedFile = JSON.parse(fileContent);
      expect(parsedFile.payload.lease_id).toBe(result.envelope.payload.lease_id);
    });
  });

  describe("registerLeaseCommands", () => {
    it("registers lease subcommand and all actions on Commander instance", () => {
      const program = new Command();
      registerLeaseCommands(program);

      const leaseCmd = program.commands.find((c) => c.name() === "lease");
      expect(leaseCmd).toBeDefined();

      const subcommands = leaseCmd!.commands.map((c) => c.name());
      expect(subcommands).toContain("create");
      expect(subcommands).toContain("list");
      expect(subcommands).toContain("revoke");
      expect(subcommands).toContain("emergency-apply");
    });
  });
});
