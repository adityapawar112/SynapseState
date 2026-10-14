import path from "node:path";
import fs from "node:fs/promises";
import pc from "picocolors";
import YAML from "yaml";
import type { Command } from "commander";
import type { KeyRole, KeyStatus } from "@synapsestate/lease";
import {
  EncryptedKeyfileSigner,
  getDefaultKeysDir,
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
 * Generates an encrypted keyfile and outputs keyset configuration for Git PR.
 */
export async function executeKeyGenerate(params: KeyGenerateParams): Promise<{
  kid: string;
  filePath: string;
  publicKeyHex: string;
  snippet: Record<string, unknown>;
}> {
  const password =
    params.password ?? process.env.SYNAPSE_KEY_PASSWORD ?? "";

  const outDir = params.dir
    ? path.resolve(params.dir)
    : getDefaultKeysDir();

  const { signer, filePath, publicKeyHex } =
    await EncryptedKeyfileSigner.generate({
      kid: params.kid,
      password,
      outDir,
      overwrite: params.overwrite,
    });

  const roles =
    params.roles && params.roles.length > 0
      ? params.roles
      : (["lease_signer"] as KeyRole[]);

  const snippet = {
    [signer.kid]: {
      public_key: publicKeyHex,
      roles,
      status: "active",
      ...(params.maxTtl ? { max_ttl_seconds: params.maxTtl } : {}),
    },
  };

  console.log(pc.green(pc.bold("\n✓ Keypair generated and encrypted successfully!")));
  console.log(pc.dim("--------------------------------------------------"));
  console.log(`${pc.bold("Key ID (kid):")}    ${signer.kid}`);
  console.log(`${pc.bold("File Path:")}       ${filePath}`);
  console.log(`${pc.bold("Public Key:")}      ${publicKeyHex}`);
  console.log(pc.dim("--------------------------------------------------"));
  console.log(pc.cyan("Add the following entry to your Git keyset.json / keyset.yaml:"));
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
    const dir = params.dir
      ? path.resolve(params.dir)
      : getDefaultKeysDir();
    targetFile = path.join(dir, `${params.kid}.key`);
  } else {
    throw new Error("Either --kid or --file must be specified for export-public");
  }

  try {
    await fs.access(targetFile);
  } catch {
    throw new Error(`Keyfile not found: "${targetFile}"`);
  }

  const meta = await EncryptedKeyfileSigner.readMetadata(targetFile);

  const roles =
    params.roles && params.roles.length > 0
      ? params.roles
      : (["lease_signer"] as KeyRole[]);

  const entry = {
    public_key: meta.publicKey,
    roles,
    status: params.status ?? "active",
    ...(params.maxTtl ? { max_ttl_seconds: params.maxTtl } : {}),
  };

  const snippet = {
    [meta.kid]: entry,
  };

  if (params.format === "yaml") {
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
    .description("Generate a new Ed25519 keypair encrypted with AES-256-GCM + scrypt")
    .requiredOption("-k, --kid <kid>", "Key identifier (e.g. alice-oncall-sre)")
    .option("-p, --password <password>", "Passphrase for AES-256-GCM keyfile encryption")
    .option("-d, --dir <dir>", "Output directory for keyfile (defaults to ~/.synapse/keys)")
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
    .description("Export public key entry formatted for Git keyset.json / keyset.yaml")
    .option("-k, --kid <kid>", "Key identifier to locate keyfile in keys directory")
    .option("-f, --file <file>", "Direct path to .key file")
    .option("-d, --dir <dir>", "Directory containing keyfiles (defaults to ~/.synapse/keys)")
    .option("--format <format>", "Output format: json or yaml", "json")
    .option(
      "-r, --roles <roles...>",
      "Authorized roles in keyset snippet (default: lease_signer)",
      ["lease_signer"],
    )
    .option("-s, --status <status>", "Key lifecycle status (default: active)", "active")
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
