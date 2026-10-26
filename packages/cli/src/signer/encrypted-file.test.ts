import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { EncryptedKeyfileSigner } from "./encrypted-file.js";
import { resolvePublicKey } from "@synapsestate/lease";

describe("EncryptedKeyfileSigner (packages/cli/src/signer/encrypted-file.ts)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-signer-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("Key Generation & Formatting", () => {
    it("generates an encrypted keyfile with AES-256-GCM and scrypt", async () => {
      const kid = "alice-oncall-test";
      const password = "super-secure-incident-passphrase-2026!";

      const { signer, filePath, publicKeyHex } =
        await EncryptedKeyfileSigner.generate({
          kid,
          password,
          outDir: tempDir,
        });

      expect(signer.kid).toBe(kid);
      expect(publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
      expect(filePath).toBe(path.join(tempDir, `${kid}.key`));

      // Verify file content structure
      const rawContent = await fs.readFile(filePath, "utf8");
      const keyfile = JSON.parse(rawContent);

      expect(keyfile.v).toBe(1);
      expect(keyfile.kid).toBe(kid);
      expect(keyfile.kdf.algorithm).toBe("scrypt");
      expect(keyfile.kdf.params).toEqual({
        N: 32768,
        r: 8,
        p: 1,
        keyLen: 32,
      });
      expect(typeof keyfile.kdf.salt).toBe("string");
      expect(keyfile.cipher.algorithm).toBe("aes-256-gcm");
      expect(typeof keyfile.cipher.iv).toBe("string");
      expect(typeof keyfile.cipher.tag).toBe("string");
      expect(typeof keyfile.ciphertext).toBe("string");
      expect(keyfile.public_key).toBe(publicKeyHex);
      expect(typeof keyfile.created_at).toBe("string");
    });

    it("rejects empty or whitespace-only passphrases", async () => {
      await expect(
        EncryptedKeyfileSigner.generate({
          kid: "bob-test",
          password: "",
          outDir: tempDir,
        }),
      ).rejects.toThrow(/passphrase cannot be empty/i);

      await expect(
        EncryptedKeyfileSigner.generate({
          kid: "bob-test",
          password: "    ",
          outDir: tempDir,
        }),
      ).rejects.toThrow(/passphrase cannot be empty/i);
    });

    it("rejects invalid or forbidden kid identifiers", async () => {
      await expect(
        EncryptedKeyfileSigner.generate({
          kid: "__proto__",
          password: "password123!",
          outDir: tempDir,
        }),
      ).rejects.toThrow(/forbidden reserved identifier/i);

      await expect(
        EncryptedKeyfileSigner.generate({
          kid: "invalid key with spaces",
          password: "password123!",
          outDir: tempDir,
        }),
      ).rejects.toThrow(/violates kid format requirements/i);
    });

    it("refuses to overwrite existing keyfile unless overwrite is true", async () => {
      const kid = "charlie-test";
      await EncryptedKeyfileSigner.generate({
        kid,
        password: "password123!",
        outDir: tempDir,
      });

      await expect(
        EncryptedKeyfileSigner.generate({
          kid,
          password: "password123!",
          outDir: tempDir,
          overwrite: false,
        }),
      ).rejects.toThrow(/keyfile already exists/i);
    });
  });

  describe("Loading & Decryption", () => {
    it("loads keyfile and decrypts with correct password", async () => {
      const kid = "david-test";
      const password = "my-test-password-42";

      const { filePath, publicKeyHex } = await EncryptedKeyfileSigner.generate({
        kid,
        password,
        outDir: tempDir,
      });

      const signer = await EncryptedKeyfileSigner.load({
        filePath,
        password,
      });

      expect(signer.kid).toBe(kid);
      expect(signer.getPublicKey()).toBe(publicKeyHex);
    });

    it("fails with wrong password", async () => {
      const kid = "eve-test";
      const { filePath } = await EncryptedKeyfileSigner.generate({
        kid,
        password: "correct-password-123",
        outDir: tempDir,
      });

      await expect(
        EncryptedKeyfileSigner.load({
          filePath,
          password: "wrong-password-456",
        }),
      ).rejects.toThrow(/authentication tag failed|failed to decrypt/i);
    });

    it("fails if ciphertext is corrupted", async () => {
      const kid = "frank-test";
      const { filePath } = await EncryptedKeyfileSigner.generate({
        kid,
        password: "password123!",
        outDir: tempDir,
      });

      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      // Corrupt ciphertext
      const buf = Buffer.from(raw.ciphertext, "base64url");
      buf[0] ^= 0xff;
      raw.ciphertext = buf.toString("base64url");
      await fs.writeFile(filePath, JSON.stringify(raw), {
        mode: 0o600,
        encoding: "utf8",
      });

      await expect(
        EncryptedKeyfileSigner.load({
          filePath,
          password: "password123!",
        }),
      ).rejects.toThrow(/failed to decrypt|unsupported state/i);
    });

    it("fails if AAD is tampered with (e.g. kid modified in header)", async () => {
      const kid = "grace-test";
      const { filePath } = await EncryptedKeyfileSigner.generate({
        kid,
        password: "password123!",
        outDir: tempDir,
      });

      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      // Tamper with kid
      raw.kid = "tampered-kid";
      await fs.writeFile(filePath, JSON.stringify(raw), {
        mode: 0o600,
        encoding: "utf8",
      });

      await expect(
        EncryptedKeyfileSigner.load({
          filePath,
          password: "password123!",
        }),
      ).rejects.toThrow(/failed to decrypt|unsupported state/i);
    });

    it("rejects empty or whitespace password in load()", async () => {
      const kid = "empty-pwd-test";
      const { filePath } = await EncryptedKeyfileSigner.generate({
        kid,
        password: "valid-passphrase-123!",
        outDir: tempDir,
      });

      await expect(
        EncryptedKeyfileSigner.load({
          filePath,
          password: "",
        }),
      ).rejects.toThrow(/passphrase cannot be empty/i);

      await expect(
        EncryptedKeyfileSigner.load({
          filePath,
          password: "   ",
        }),
      ).rejects.toThrow(/passphrase cannot be empty/i);
    });

    it("rejects downgraded or unsupported KDF parameters (KDF pinning)", async () => {
      const kid = "downgrade-test";
      const { filePath } = await EncryptedKeyfileSigner.generate({
        kid,
        password: "password123!",
        outDir: tempDir,
      });

      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      // Simulate downgrade attack with N=1024
      raw.kdf.params.N = 1024;
      await fs.writeFile(filePath, JSON.stringify(raw), {
        mode: 0o600,
        encoding: "utf8",
      });

      await expect(
        EncryptedKeyfileSigner.load({
          filePath,
          password: "password123!",
        }),
      ).rejects.toThrow(/unsupported or invalid kdf parameters/i);
    });

    it("rejects invalid salt, iv, or tag lengths in load()", async () => {
      const kid = "invalid-lengths-test";
      const { filePath } = await EncryptedKeyfileSigner.generate({
        kid,
        password: "password123!",
        outDir: tempDir,
      });

      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      raw.cipher.iv = Buffer.from("short").toString("base64url"); // 5 bytes instead of 12
      await fs.writeFile(filePath, JSON.stringify(raw), {
        mode: 0o600,
        encoding: "utf8",
      });

      await expect(
        EncryptedKeyfileSigner.load({
          filePath,
          password: "password123!",
        }),
      ).rejects.toThrow(/invalid cipher or kdf component length/i);
    });

    it("verifies public_key in file matches decrypted private key (defense-in-depth)", async () => {
      const kid = "pubkey-tamper-test";
      const { filePath } = await EncryptedKeyfileSigner.generate({
        kid,
        password: "password123!",
        outDir: tempDir,
      });

      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      // Swap out public_key in unencrypted header with a fake 64-char hex key
      raw.public_key = "00".repeat(32);
      await fs.writeFile(filePath, JSON.stringify(raw), {
        mode: 0o600,
        encoding: "utf8",
      });

      await expect(
        EncryptedKeyfileSigner.load({
          filePath,
          password: "password123!",
        }),
      ).rejects.toThrow(
        /public key in keyfile header does not match decrypted private key/i,
      );
    });
  });

  describe("Signing & Verification", () => {
    it("produces valid base64url Ed25519 signature verifiable against public key", async () => {
      const kid = "heidi-signer";
      const password = "heidi-incident-key!";

      const { signer, publicKeyHex } = await EncryptedKeyfileSigner.generate({
        kid,
        password,
        outDir: tempDir,
      });

      const message = Buffer.from("synapsestate:test:message:payload", "utf8");
      const signature = await signer.sign(message);

      expect(typeof signature).toBe("string");
      expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/); // 64 bytes base64url is 86 chars

      // Verify signature using Node crypto directly
      const publicKey = resolvePublicKey(publicKeyHex);
      const isVerified = crypto.verify(
        null,
        message,
        publicKey,
        Buffer.from(signature, "base64url"),
      );
      expect(isVerified).toBe(true);
    });
  });

  describe("Filesystem Hygiene & Metadata Reading", () => {
    it("readMetadata extracts public key without requiring password", async () => {
      const kid = "ivan-metadata";
      const password = "ivan-secret-passphrase";

      const { filePath, publicKeyHex } = await EncryptedKeyfileSigner.generate({
        kid,
        password,
        outDir: tempDir,
      });

      const meta = await EncryptedKeyfileSigner.readMetadata(filePath);
      expect(meta.kid).toBe(kid);
      expect(meta.publicKey).toBe(publicKeyHex);
      expect(meta.createdAt).toBeDefined();
    });

    it("readMetadata rejects corrupted JSON or invalid public key hex", async () => {
      const corruptFile = path.join(tempDir, "corrupted.key");
      await fs.writeFile(corruptFile, "{not-json", {
        mode: 0o600,
        encoding: "utf8",
      });

      await expect(
        EncryptedKeyfileSigner.readMetadata(corruptFile),
      ).rejects.toThrow(/failed to parse keyfile json/i);

      const invalidKeyFile = path.join(tempDir, "invalid-key.key");
      await fs.writeFile(
        invalidKeyFile,
        JSON.stringify({
          v: 1,
          kid: "test-kid",
          public_key: "not-a-valid-hex-key",
          created_at: new Date().toISOString(),
        }),
        { mode: 0o600, encoding: "utf8" },
      );

      await expect(
        EncryptedKeyfileSigner.readMetadata(invalidKeyFile),
      ).rejects.toThrow(/invalid ed25519 public key format/i);
    });

    it("enforces POSIX 0600 mode and fails if group or other accessible", async () => {
      // Mock stat for POSIX mode testing
      const fakeFilePath = path.join(tempDir, "posix-test.key");
      await fs.writeFile(fakeFilePath, JSON.stringify({ v: 1 }), "utf8");

      try {
        // Mock group-readable mode (0o644)
        vi.spyOn(fs, "stat").mockResolvedValueOnce({
          mode: 0o100644,
          isFile: () => true,
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // Temporarily override platform to simulate linux/darwin
        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "linux" });

        await expect(
          EncryptedKeyfileSigner.checkPermissions(fakeFilePath),
        ).rejects.toThrow(/insecure file permissions/i);

        Object.defineProperty(process, "platform", { value: originalPlatform });
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("logs security warning on Windows platform", async () => {
      const fakeFilePath = path.join(tempDir, "win-test.key");
      await fs.writeFile(fakeFilePath, JSON.stringify({ v: 1 }), "utf8");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const originalPlatform = process.platform;
      try {
        Object.defineProperty(process, "platform", { value: "win32" });

        await EncryptedKeyfileSigner.checkPermissions(fakeFilePath);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            "Windows does not support POSIX 0600 permissions",
          ),
        );
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        warnSpy.mockRestore();
      }
    });
  });
});
