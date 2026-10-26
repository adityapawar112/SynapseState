import path from "node:path";
import fs from "node:fs/promises";
import pc from "picocolors";
import YAML from "yaml";
import type { Command } from "commander";
import {
  KEY_ROLE_VALUES,
  KEY_STATUS_VALUES,
  type KeyRole,
  type KeyStatus,
} from "@synapsestate/lease";
import {
  EncryptedKeyfileSigner,
  getDefaultKeysDir,
  validateKid,
} from "../signer/encrypted-file.js";

export interface KeyGenerateParams {
  kid: string;
  password?: string;
  dir?: string;
  roles?: KeyRole[];
  maxTtl?: number;
  overwrite?: boolean;
}

export interface KeyExportPublicParams {
  kid?: string;
  file?: string;
  dir?: string;
  format?: "json" | "yaml";
  roles?: KeyRole[];
  status?: KeyStatus;
  maxTtl?: number;
}

/**
 * Validates roles array against KEY_ROLE_VALUES.
 */
function validateRoles(roles: readonly KeyRole[]): void {
  for (const r of roles) {
    if (!KEY_ROLE_VALUES.includes(r)) {
      throw new Error(
        `Invalid key role "${r}". Must be one of: ${KEY_ROLE_VALUES.join(", ")}`,
      );
    }
  }
}

/**
 * Validates maxTtl bounds (1 to 86400 seconds).
 */
function validateMaxTtl(maxTtl: number): void {
  if (
    typeof maxTtl !== "number" ||
    Number.isNaN(maxTtl) ||
    !Number.isInteger(maxTtl) ||
    maxTtl <= 0 ||
    maxTtl > 86400
  ) {
    throw new Error(
      `max-ttl must be a positive integer between 1 and 86400 seconds (got ${maxTtl})`,
    );
  }
}

/**
 * Generates an encrypted keyfile and outputs keyset configuration for Git PR.
 */
export async function executeKeyGenerate(params: KeyGenerateParams): Promise<{
  kid: string;
  filePath: string;
  publicKeyHex: string;
  snippet: Record<string, unknown>;
}> {
  validateKid(params.kid);

  const password = params.password ?? process.env.SYNAPSE_KEY_PASSWORD ?? "";

  const outDir = params.dir ? path.resolve(params.dir) : getDefaultKeysDir();

  const roles =
    params.roles && params.roles.length > 0
      ? params.roles
      : (["lease_signer"] as KeyRole[]);
  validateRoles(roles);

  const maxTtl = params.maxTtl ?? 3600;
  validateMaxTtl(maxTtl);

  const { signer, filePath, publicKeyHex } =
    await EncryptedKeyfileSigner.generate({
      kid: params.kid,
      password,
      outDir,
      overwrite: params.overwrite,
    });

  const snippet = {
    [signer.kid]: {
      public_key: publicKeyHex,
      roles,
      status: "active",
      max_ttl_seconds: maxTtl,
    },
  };

  console.log(
    pc.green(pc.bold("\n✓ Keypair generated and encrypted successfully!")),
  );
  console.log(pc.dim("--------------------------------------------------"));
  console.log(`${pc.bold("Key ID (kid):")}    ${signer.kid}`);
  console.log(`${pc.bold("File Path:")}       ${filePath}`);
  console.log(`${pc.bold("Public Key:")}      ${publicKeyHex}`);
  console.log(pc.dim("--------------------------------------------------"));
  console.log(
    pc.cyan("Add the following entry to your Git keyset.json / keyset.yaml:"),
  );
  console.log(JSON.stringify(snippet, null, 2) + "\n");

  return {
    kid: signer.kid,
    filePath,
    publicKeyHex,
    snippet,
  };
}

/**
 * Reads unencrypted metadata from a keyfile and exports the public key as a keyset entry.
 */
export async function executeKeyExportPublic(
  params: KeyExportPublicParams,
): Promise<string> {
  let targetFile: string;

  if (params.file) {
    targetFile = path.resolve(params.file);
  } else if (params.kid) {
    validateKid(params.kid);
    const dir = params.dir ? path.resolve(params.dir) : getDefaultKeysDir();
    targetFile = path.join(dir, `${params.kid}.key`);
  } else {
    throw new Error(
      "Either --kid or --file must be specified for export-public",
    );
  }

  const format = params.format ?? "json";
  if (format !== "json" && format !== "yaml") {
    throw new Error(
      `Unsupported format "${format}". Must be "json" or "yaml".`,
    );
  }

  const roles =
    params.roles && params.roles.length > 0
      ? params.roles
      : (["lease_signer"] as KeyRole[]);
  validateRoles(roles);

  const status = params.status ?? "active";
  if (!KEY_STATUS_VALUES.includes(status)) {
    throw new Error(
      `Invalid key status "${status}". Must be one of: ${KEY_STATUS_VALUES.join(", ")}`,
    );
  }

  const maxTtl = params.maxTtl ?? 3600;
  validateMaxTtl(maxTtl);

  try {
    await fs.access(targetFile);
  } catch {
    throw new Error(`Keyfile not found: "${targetFile}"`);
  }

  const meta = await EncryptedKeyfileSigner.readMetadata(targetFile);

  const entry = {
    public_key: meta.publicKey,
    roles,
    status,
    max_ttl_seconds: maxTtl,
  };

  const snippet = {
    [meta.kid]: entry,
  };

  if (format === "yaml") {
    return YAML.stringify(snippet);
  }

  return JSON.stringify(snippet, null, 2);
}

/**
 * Registers `synapse key generate` and `synapse key export-public` commands.
 */
export function registerKeyCommands(program: Command): void {
  const key = program
    .command("key")
    .description("Manage cryptographic operator keys and keyset exports");

  key
    .command("generate")
    .description(
      "Generate a new Ed25519 keypair encrypted with AES-256-GCM + scrypt",
    )
    .requiredOption("-k, --kid <kid>", "Key identifier (e.g. alice-oncall-sre)")
    .option(
      "-p, --password <password>",
      "Passphrase for AES-256-GCM keyfile encryption (WARNING: CLI arguments may be visible in process listings; prefer SYNAPSE_KEY_PASSWORD environment variable)",
    )
    .option(
      "-d, --dir <dir>",
      "Output directory for keyfile (defaults to ~/.synapse/keys)",
    )
    .option(
      "-r, --roles <roles...>",
      "Authorized roles in keyset snippet (default: lease_signer)",
      ["lease_signer"],
    )
    .option(
      "-m, --max-ttl <seconds>",
      "Maximum allowed lease TTL in seconds (default: 3600)",
      (v) => parseInt(v, 10),
      3600,
    )
    .option("--overwrite", "Overwrite keyfile if it already exists", false)
    .action(async (opts) => {
      try {
        await executeKeyGenerate({
          kid: opts.kid,
          password: opts.password,
          dir: opts.dir,
          roles: opts.roles as KeyRole[],
          maxTtl: opts.maxTtl,
          overwrite: opts.overwrite,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`Error: ${message}`));
        process.exitCode = 1;
      }
    });

  key
    .command("export-public")
    .description(
      "Export public key entry formatted for Git keyset.json / keyset.yaml",
    )
    .option(
      "-k, --kid <kid>",
      "Key identifier to locate keyfile in keys directory",
    )
    .option("-f, --file <file>", "Direct path to .key file")
    .option(
      "-d, --dir <dir>",
      "Directory containing keyfiles (defaults to ~/.synapse/keys)",
    )
    .option("--format <format>", "Output format: json or yaml", "json")
    .option(
      "-r, --roles <roles...>",
      "Authorized roles in keyset snippet (default: lease_signer)",
      ["lease_signer"],
    )
    .option(
      "-s, --status <status>",
      "Key lifecycle status (default: active)",
      "active",
    )
    .option(
      "-m, --max-ttl <seconds>",
      "Maximum allowed lease TTL in seconds (default: 3600)",
      (v) => parseInt(v, 10),
      3600,
    )
    .action(async (opts) => {
      try {
        const output = await executeKeyExportPublic({
          kid: opts.kid,
          file: opts.file,
          dir: opts.dir,
          format: opts.format,
          roles: opts.roles as KeyRole[],
          status: opts.status as KeyStatus,
          maxTtl: opts.maxTtl,
        });
        console.log(output);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`Error: ${message}`));
        process.exitCode = 1;
      }
    });
}
