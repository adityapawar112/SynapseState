import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { Command } from "commander";
import { executeLog, registerLogCommands, parseSince } from "./log.js";
import { signLeaseWithSigner } from "@synapsestate/lease";
import { EncryptedKeyfileSigner } from "../signer/encrypted-file.js";

describe("Incident Investigation & Log Commands (packages/cli/src/commands/log.ts)", () => {
  const FIXED_NOW = new Date("2026-10-16T12:00:00.000Z").getTime();

  describe("parseSince", () => {
    it("parses relative durations in s, m, h, d", () => {
      const now = new Date("2026-10-16T12:00:00.000Z");
      expect(parseSince("30s", now).toISOString()).toBe("2026-10-16T11:59:30.000Z");
      expect(parseSince("15m", now).toISOString()).toBe("2026-10-16T11:45:00.000Z");
      expect(parseSince("2h", now).toISOString()).toBe("2026-10-16T10:00:00.000Z");
      expect(parseSince("1d", now).toISOString()).toBe("2026-10-15T12:00:00.000Z");
    });

    it("parses ISO timestamps", () => {
      const iso = "2026-10-16T08:30:00.000Z";
      expect(parseSince(iso).toISOString()).toBe(iso);
    });

    it("throws on invalid since format", () => {
      expect(() => parseSince("invalid-time")).toThrow(/Invalid duration or timestamp format/i);
    });
  });

  describe("Online Mode (Control API Query)", () => {
    it("queries GET /v1/changes with correct query params and ranks suspects", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          query: {
            env: "production",
            since: "30m",
            service: "checkout-service",
            limit: 50,
          },
          events: [
            {
              id: 101,
              event_type: "LEASE_CREATED",
              env: "production",
              flag_key: "checkout-v2",
              actor: "alice-sre",
              occurred_at: new Date(FIXED_NOW - 2 * 60 * 1000).toISOString(),
              payload: { value: true },
            },
          ],
          evaluations: [
            {
              flag_key: "checkout-v2",
              variant: "true",
              eval_count: 50000,
            },
          ],
        }),
      });

      const res = await executeLog({
        service: "checkout-service",
        env: "production",
        since: "30m",
        limit: 50,
        apiUrl: "http://control-api:3000",
        fetchFn: mockFetch as unknown as typeof fetch,
        nowMs: FIXED_NOW,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("http://control-api:3000/v1/changes?");
      expect(calledUrl).toContain("env=production");
      expect(calledUrl).toContain("since=30m");
      expect(calledUrl).toContain("service=checkout-service");
      expect(calledUrl).toContain("limit=50");

      expect(res.suspects).toHaveLength(1);
      expect(res.suspects[0].flag_key).toBe("checkout-v2");
      expect(res.suspects[0].suggested_action.suggested_value).toBe(false);
      expect(res.suspects[0].suggested_action.command).toContain(
        "synapse lease create --flag checkout-v2 --env production --value false --ttl 30m",
      );

      // Verify formatted table output
      expect(res.formattedOutput).toContain("checkout-v2");
      expect(res.formattedOutput).toContain("LEASE_CREATED");
      expect(res.formattedOutput).toContain("Top Suspect Mitigations");
    });

    it("emits machine-readable JSON when json is true", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          query: { env: "production", since: "15m" },
          events: [],
          evaluations: [],
        }),
      });

      const res = await executeLog({
        service: "payment-service",
        env: "production",
        since: "15m",
        json: true,
        fetchFn: mockFetch as unknown as typeof fetch,
        nowMs: FIXED_NOW,
      });

      const parsed = JSON.parse(res.formattedOutput);
      expect(parsed.query.env).toBe("production");
      expect(parsed.suspects).toEqual([]);
      expect(parsed.events).toEqual([]);
    });

    it("throws helpful error advising --offline when Control API is unreachable", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));

      await expect(
        executeLog({
          service: "checkout-service",
          env: "production",
          apiUrl: "http://down-api:3000",
          fetchFn: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(/Control API unreachable at.*--offline/i);
    });

    it("throws error with server status when Control API returns non-200", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ error: "Missing required query parameter: env" }),
      });

      await expect(
        executeLog({
          service: "checkout-service",
          env: "production",
          fetchFn: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(/Failed to fetch change history.*400/i);
    });
  });

  describe("Offline Mode (--offline)", () => {
    let tempDir: string;
    let emergencyDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-cli-log-test-"));
      emergencyDir = path.join(tempDir, "emergency-leases");
      await fs.mkdir(emergencyDir, { recursive: true });
    });

    it("inspects local git commits and emergency lease files", async () => {
      // 1. Create a signed emergency lease file in emergencyDir
      const gen = await EncryptedKeyfileSigner.generate({
        kid: "alice-oncall-sre",
        password: "SecretPassword123!",
        outDir: tempDir,
      });

      const signer = await EncryptedKeyfileSigner.load({
        filePath: gen.filePath,
        password: "SecretPassword123!",
      });

      const envelope = await signLeaseWithSigner(
        {
          v: 1,
          lease_id: "01M51P9JVWKP5GYZSYNBE5V8RG",
          env: "production",
          flag_key: "offline-flag",
          value: "canary",
          issued_at: new Date(FIXED_NOW - 60000).toISOString(),
          ttl_seconds: 1800,
          reason: "Emergency offline test lease",
          kid: "alice-oncall-sre",
          nonce: "test-nonce-12345",
        },
        signer,
      );

      await fs.writeFile(
        path.join(emergencyDir, "01M51P9JVWKP5GYZSYNBE5V8RG.json"),
        JSON.stringify(envelope, null, 2),
      );

      // 2. Mock gitRunner returning a commit that modified flags/production/git-flag.yaml
      const gitLogOutput = [
        `c0ffee1234567890\tgit-author\t${new Date(FIXED_NOW - 10 * 60 * 1000).toISOString()}\tfeat(flags): update git-flag`,
        "flags/production/git-flag.yaml",
      ].join("\n");

      const mockGitRunner = vi.fn().mockResolvedValue(gitLogOutput);

      const res = await executeLog({
        service: "checkout-service",
        env: "production",
        since: "30m",
        offline: true,
        offlineDirs: [emergencyDir],
        gitRunner: mockGitRunner,
        nowMs: FIXED_NOW,
      });

      expect(res.warning).toContain("OFFLINE MODE");
      expect(res.suspects).toHaveLength(2);

      const flagKeys = res.suspects.map((s) => s.flag_key);
      expect(flagKeys).toContain("offline-flag");
      expect(flagKeys).toContain("git-flag");

      // Verify the more recent lease has higher recency score than the 10m old git commit
      expect(res.suspects[0].flag_key).toBe("offline-flag");
      expect(res.suspects[0].suggested_action.suggested_value).toBe("control");
    });

    it("handles missing git directory or git error gracefully in offline mode", async () => {
      const failingGitRunner = vi.fn().mockRejectedValue(new Error("fatal: not a git repository"));

      const res = await executeLog({
        service: "checkout-service",
        env: "production",
        since: "30m",
        offline: true,
        offlineDirs: [emergencyDir],
        gitRunner: failingGitRunner,
        nowMs: FIXED_NOW,
      });

      expect(res.warning).toContain("OFFLINE MODE");
      expect(res.suspects).toEqual([]);
    });
  });

  describe("Commander CLI Registration", () => {
    it("registers log command on program instance", () => {
      const program = new Command();
      registerLogCommands(program);

      const logCmd = program.commands.find((c) => c.name() === "log");
      expect(logCmd).toBeDefined();
      expect(logCmd?.description()).toContain("incident");

      const optionNames = logCmd?.options.map((o) => o.name());
      expect(optionNames).toContain("service");
      expect(optionNames).toContain("env");
      expect(optionNames).toContain("since");
      expect(optionNames).toContain("flag");
      expect(optionNames).toContain("limit");
      expect(optionNames).toContain("offline");
      expect(optionNames).toContain("json");
    });
  });
});
