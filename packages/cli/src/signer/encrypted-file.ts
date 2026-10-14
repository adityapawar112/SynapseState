import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  KID_REGEX,
  FORBIDDEN_KID_NAMES,
  formatPublicKeyToHex,
} from "@synapsestate/lease";
import type { Signer } from "./interface.js";

export interface KeyfileKdf {
  algorithm: "scrypt";
  params: {
    N: number;
    r: number;
    p: number;
    keyLen: number;
  };
  salt: string; // base64url
}

export interface KeyfileCipher {
  algorithm: "aes-256-gcm";
  iv: string; // base64url
  tag: string; // base64url
}

export interface KeyfileData {
  v: 1;
  kid: string;
  kdf: KeyfileKdf;
  cipher: KeyfileCipher;
  ciphertext: string; // base64url
  public_key: string; // 64-char hex
  created_at: string; // ISO 8601
}

export interface GenerateOptions {
  kid: string;
  password: string;
  outDir?: string;
  overwrite?: boolean;
}

export interface LoadOptions {
  filePath: string;
  password: string;
}

export interface KeyMetadata {
  kid: string;
  publicKey: string;
  createdAt: string;
}

/**
 * Standard scrypt KDF parameters (N=32768, r=8, p=1, keyLen=32).
 * Conforms to SynapseState Key Storage Threat Model (ARCHITECTURE.md §1 & ADR 0004).
 */
const SCRYPT_PARAMS = Object.freeze({
  N: 32768,
  r: 8,
  p: 1,
  keyLen: 32,
  maxmem: 64 * 1024 * 1024,
});

/**
 * Default directory for operator keys (~/.synapse/keys).
 */
export function getDefaultKeysDir(): string {
  if (process.env.SYNAPSE_KEYS_DIR) {
    return path.resolve(process.env.SYNAPSE_KEYS_DIR);
  }
  return path.join(os.homedir(), ".synapse", "keys");
}

/**
 * Computes AAD (Additional Authenticated Data) for keyfile encryption.
 * Cryptographically binds kid and format version to ciphertext.
 */
function computeAad(kid: string, version: number): Buffer {
  return Buffer.from(`synapsestate:keyfile:v${version}:${kid}`, "utf8");
}

/**
 * Derives an AES-256 key from a passphrase and salt using scrypt.
 */
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_PARAMS.keyLen,
      {
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
        maxmem: SCRYPT_PARAMS.maxmem,
      },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
}

/**
 * Validates a key identifier according to KID_REGEX and forbidden property names.
 */
function validateKid(kid: string): void {
  if (typeof kid !== "string" || kid.trim().length === 0) {
    throw new Error("kid must not be empty");
  }
  if ((FORBIDDEN_KID_NAMES as readonly string[]).includes(kid)) {
    throw new Error(
      `Keyset contains forbidden reserved identifier: "${kid}"`,
    );
  }
  if (!KID_REGEX.test(kid)) {
    throw new Error(
      `Keyset key "${kid}" violates kid format requirements (must match ${KID_REGEX})`,
    );
  }
}

/**
 * EncryptedKeyfileSigner
 *
 * Implements the pluggable `Signer` interface using an AES-256-GCM + scrypt encrypted
 * keyfile stored on disk (~/.synapse/keys/<kid>.key) with strict 0600 POSIX permissions.
 */
export class EncryptedKeyfileSigner implements Signer {
  readonly kid: string;
  private readonly privateKey: crypto.KeyObject;
  private readonly publicKeyHex: string;

  constructor(kid: string, privateKey: crypto.KeyObject, publicKeyHex: string) {
    this.kid = kid;
    this.privateKey = privateKey;
    this.publicKeyHex = publicKeyHex;
  }

  /**
   * Signs a message buffer using Ed25519.
   * Returns a 64-byte Ed25519 signature encoded as base64url.
   */
  async sign(message: Uint8Array): Promise<string> {
    const signatureBuffer = crypto.sign(
      null,
      Buffer.from(message),
      this.privateKey,
    );
    return signatureBuffer.toString("base64url");
  }

  /**
   * Returns the 64-character lowercase hex Ed25519 public key.
   */
  getPublicKey(): string {
    return this.publicKeyHex;
  }

  /**
   * Enforces filesystem permission hygiene on a keyfile:
   * - On POSIX: strictly enforces mode 0600 (fails if group or world accessible).
   * - On Windows: logs a security warning.
   */
  static async checkPermissions(filePath: string): Promise<void> {
    const stat = await fs.stat(filePath);

    if (process.platform === "win32") {
      console.warn(
        `[SECURITY WARNING] Windows does not support POSIX 0600 permissions for keyfile "${filePath}". Ensure proper Windows ACLs protect this file.`,
      );
      return;
    }

    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Insecure file permissions for "${filePath}": mode is 0o${mode.toString(8)}, must be 0600 (no group or other access allowed). Run chmod 0600 "${filePath}".`,
      );
    }
  }

  /**
   * Reads unencrypted metadata from a keyfile header without prompting for passphrase.
   */
  static async readMetadata(filePath: string): Promise<KeyMetadata> {
    await EncryptedKeyfileSigner.checkPermissions(filePath);
    const content = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(content) as KeyfileData;

    if (data.v !== 1) {
      throw new Error(
        `Unsupported keyfile version ${data.v} in "${filePath}". Expected version 1.`,
      );
    }
    validateKid(data.kid);

    return {
      kid: data.kid,
      publicKey: data.public_key,
      createdAt: data.created_at,
    };
  }

  /**
   * Generates a new Ed25519 keypair, encrypts the private key using scrypt + AES-256-GCM + AAD,
   * writes the keyfile to disk with mode 0600, and returns the active signer and public key.
   */
  static async generate(options: GenerateOptions): Promise<{
    signer: EncryptedKeyfileSigner;
    filePath: string;
    publicKeyHex: string;
  }> {
    validateKid(options.kid);

    if (!options.password || options.password.trim().length === 0) {
      throw new Error("Passphrase cannot be empty or whitespace");
    }

    const outDir = options.outDir
      ? path.resolve(options.outDir)
      : getDefaultKeysDir();

    await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(outDir, `${options.kid}.key`);

    if (!options.overwrite) {
      try {
        await fs.access(filePath);
        throw new Error(
          `Keyfile already exists at "${filePath}". Use overwrite: true or --overwrite flag to replace it.`,
        );
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }

    // Generate Ed25519 keypair
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyHex = formatPublicKeyToHex(publicKey);
    const privateKeyDer = privateKey.export({ type: "pkcs8", format: "der" });

    // Derive encryption key via scrypt
    const salt = crypto.randomBytes(16);
    const derivedKey = await deriveKey(options.password, salt);

    // Encrypt with AES-256-GCM
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);
    const aad = computeAad(options.kid, 1);
    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([
      cipher.update(privateKeyDer),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const keyfileData: KeyfileData = {
      v: 1,
      kid: options.kid,
      kdf: {
        algorithm: "scrypt",
        params: {
          N: SCRYPT_PARAMS.N,
          r: SCRYPT_PARAMS.r,
          p: SCRYPT_PARAMS.p,
          keyLen: SCRYPT_PARAMS.keyLen,
        },
        salt: salt.toString("base64url"),
      },
      cipher: {
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        tag: tag.toString("base64url"),
      },
      ciphertext: ciphertext.toString("base64url"),
      public_key: publicKeyHex,
      created_at: new Date().toISOString(),
    };

    await fs.writeFile(filePath, JSON.stringify(keyfileData, null, 2) + "\n", {
      mode: 0o600,
      encoding: "utf8",
    });

    const signer = new EncryptedKeyfileSigner(
      options.kid,
      privateKey,
      publicKeyHex,
    );

    return {
      signer,
      filePath,
      publicKeyHex,
    };
  }

  /**
   * Loads an existing encrypted keyfile from disk, validates permissions and AAD,
   * decrypts the private key with the passphrase, and returns an active signer.
   */
  static async load(options: LoadOptions): Promise<EncryptedKeyfileSigner> {
    const filePath = path.resolve(options.filePath);
    await EncryptedKeyfileSigner.checkPermissions(filePath);

    const rawContent = await fs.readFile(filePath, "utf8");
    let data: KeyfileData;
    try {
      data = JSON.parse(rawContent) as KeyfileData;
    } catch (err) {
      throw new Error(`Failed to parse keyfile JSON at "${filePath}": ${String(err)}`);
    }

    if (data.v !== 1) {
      throw new Error(
        `Unsupported keyfile version ${data.v} in "${filePath}". Expected version 1.`,
      );
    }
    validateKid(data.kid);

    if (data.kdf?.algorithm !== "scrypt" || !data.kdf.salt) {
      throw new Error(`Unsupported or missing KDF configuration in "${filePath}"`);
    }

    if (data.cipher?.algorithm !== "aes-256-gcm" || !data.cipher.iv || !data.cipher.tag) {
      throw new Error(`Unsupported or missing cipher configuration in "${filePath}"`);
    }

    const salt = Buffer.from(data.kdf.salt, "base64url");
    const iv = Buffer.from(data.cipher.iv, "base64url");
    const tag = Buffer.from(data.cipher.tag, "base64url");
    const ciphertext = Buffer.from(data.ciphertext, "base64url");

    const derivedKey = await deriveKey(options.password, salt);

    const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, iv);
    const aad = computeAad(data.kid, 1);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    let privateKeyDer: Buffer;
    try {
      privateKeyDer = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
    } catch (err) {
      throw new Error(
        `Failed to decrypt keyfile "${filePath}": invalid passphrase or corrupted ciphertext (authentication tag failed)`,
        { cause: err },
      );
    }

    const privateKey = crypto.createPrivateKey({
      key: privateKeyDer,
      format: "der",
      type: "pkcs8",
    });

    return new EncryptedKeyfileSigner(data.kid, privateKey, data.public_key);
  }
}
