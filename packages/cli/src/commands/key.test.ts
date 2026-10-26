import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { parseKeysetJson } from "@synapsestate/lease";
import {
  registerKeyCommands,
  executeKeyGenerate,
  executeKeyExportPublic,
} from "./key.js";
import { Command } from "commander";

describe("Key Management Commands (packages/cli/src/commands/key.ts)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-cli-key-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("executeKeyGenerate", () => {
    it("generates a new keyfile and outputs keyset snippet", async () => {
      const kid = "alice-oncall-sre";
      const password = "incident-response-passphrase-2026";

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const result = await executeKeyGenerate({
          kid,
          password,
          dir: tempDir,
          roles: ["lease_signer"],
          maxTtl: 3600,
        });

        expect(result.kid).toBe(kid);
        expect(result.filePath).toBe(path.join(tempDir, `${kid}.key`));
        expect(result.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);

        // Verify keyfile was created on disk
        const fileExists = await fs
          .access(result.filePath)
          .then(() => true)
          .catch(() => false);
        expect(fileExists).toBe(true);

        // Verify snippet printed to console includes valid keyset JSON
        const loggedOutput = logSpy.mock.calls
          .map((c) => c.join(" "))
          .join("\n");
        expect(loggedOutput).toContain(kid);
        expect(loggedOutput).toContain(result.publicKeyHex);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("rejects invalid key ID", async () => {
      await expect(
        executeKeyGenerate({
          kid: "__proto__",
          password: "password123!",
          dir: tempDir,
        }),
      ).rejects.toThrow(/forbidden reserved identifier/i);
    });

    it("rejects empty password", async () => {
      await expect(
        executeKeyGenerate({
          kid: "bob-sre",
          password: "",
          dir: tempDir,
        }),
      ).rejects.toThrow(/passphrase cannot be empty/i);
    });
  });

  describe("executeKeyExportPublic", () => {
    it("exports public key in valid keyset JSON format", async () => {
      const kid = "carol-oncall";
      const password = "carol-passphrase-2026!";

      // Generate key first
      await executeKeyGenerate({
        kid,
        password,
        dir: tempDir,
        roles: ["lease_signer"],
        maxTtl: 7200,
      });

      const output = await executeKeyExportPublic({
        kid,
        dir: tempDir,
        format: "json",
        roles: ["lease_signer"],
        maxTtl: 7200,
      });

      // Parse output with authoritative parseKeysetJson
      const parsedKeyset = parseKeysetJson(output);
      expect(parsedKeyset[kid]).toBeDefined();
      expect(parsedKeyset[kid].roles).toContain("lease_signer");
      expect(parsedKeyset[kid].status).toBe("active");
      expect(parsedKeyset[kid].max_ttl_seconds).toBe(7200);
      expect(parsedKeyset[kid].public_key).toMatch(/^[0-9a-f]{64}$/);
    });

    it("exports public key in valid YAML format", async () => {
      const kid = "dave-principal";
      const password = "dave-passphrase-2026!";

      await executeKeyGenerate({
        kid,
        password,
        dir: tempDir,
        roles: ["admin"],
        maxTtl: 86400,
      });

      const output = await executeKeyExportPublic({
        kid,
        dir: tempDir,
        format: "yaml",
        roles: ["admin"],
        maxTtl: 86400,
      });

      const parsedYaml = YAML.parse(output);
      expect(parsedYaml[kid]).toBeDefined();
      expect(parsedYaml[kid].roles).toContain("admin");
      expect(parsedYaml[kid].max_ttl_seconds).toBe(86400);

      // Keyset JSON validation also accepts the json-stringified YAML structure
      const parsedKeyset = parseKeysetJson(JSON.stringify(parsedYaml));
      expect(parsedKeyset[kid]).toBeDefined();
    });

    it("throws error when keyfile is not found", async () => {
      await expect(
        executeKeyExportPublic({
          kid: "non-existent-kid",
          dir: tempDir,
        }),
      ).rejects.toThrow(/keyfile not found/i);
    });

    it("rejects path traversal in kid parameter", async () => {
      await expect(
        executeKeyExportPublic({
          kid: "../../etc/passwd",
          dir: tempDir,
        }),
      ).rejects.toThrow(/violates kid format requirements/i);
    });

    it("rejects unsupported format option", async () => {
      const kid = "format-test";
      await executeKeyGenerate({
        kid,
        password: "password123!",
        dir: tempDir,
      });

      await expect(
        executeKeyExportPublic({
          kid,
          dir: tempDir,
          format: "toml" as unknown as "json" | "yaml",
        }),
      ).rejects.toThrow(/unsupported format "toml"/i);
    });

    it("rejects invalid roles or out-of-range max-ttl", async () => {
      const kid = "invalid-opts-test";
      await executeKeyGenerate({
        kid,
        password: "password123!",
        dir: tempDir,
      });

      await expect(
        executeKeyExportPublic({
          kid,
          dir: tempDir,
          roles: ["invalid_role" as unknown as "lease_signer"],
        }),
      ).rejects.toThrow(/invalid key role/i);

      await expect(
        executeKeyExportPublic({
          kid,
          dir: tempDir,
          maxTtl: 999999,
        }),
      ).rejects.toThrow(/max-ttl must be a positive integer/i);
    });

    it("defaults max_ttl_seconds to 3600 when omitted in programmatic call", async () => {
      const kid = "default-ttl-test";
      const genResult = await executeKeyGenerate({
        kid,
        password: "password123!",
        dir: tempDir,
      });

      expect(
        (genResult.snippet[kid] as Record<string, unknown>).max_ttl_seconds,
      ).toBe(3600);

      const exported = await executeKeyExportPublic({
        kid,
        dir: tempDir,
      });
      const parsed = parseKeysetJson(exported);
      expect(parsed[kid].max_ttl_seconds).toBe(3600);
    });
  });

  describe("Commander CLI Integration", () => {
    it("registers 'key generate' and 'key export-public' commands", async () => {
      const program = new Command();
      registerKeyCommands(program);

      const keyCmd = program.commands.find((c) => c.name() === "key");
      expect(keyCmd).toBeDefined();

      const subcommands = keyCmd!.commands.map((c) => c.name());
      expect(subcommands).toContain("generate");
      expect(subcommands).toContain("export-public");
    });
  });
});
