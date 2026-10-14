import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import pc from "picocolors";
import Table from "cli-table3";
import YAML from "yaml";
import type { Command } from "commander";
import {
  FLAG_KEY_REGEX,
  ULID_REGEX,
  LEASE_DOMAIN_PREFIX,
  REVOCATION_DOMAIN_PREFIX,
  canonicalizeJson,
  generateUlid,
  evaluateLeaseExpiry,
  LeasePayloadSchema,
  RevocationPayloadSchema,
  type LeaseEnvelope,
  type LeasePayload,
  type RevocationEnvelope,
  type RevocationPayload,
} from "@synapsestate/lease";
import {
  EncryptedKeyfileSigner,
  getDefaultKeysDir,
  validateKid,
} from "../signer/encrypted-file.js";

export interface LeaseCreateParams {
  env: string;
  flag: string;
  value: unknown;
  reason: string;
  ttl?: number;
  kid?: string;
  keyFile?: string;
  password?: string;
  apiUrl?: string;
  wait?: boolean;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
  fetchFn?: typeof fetch;
}

export interface LeaseCreateResult {
  leaseId: string;
  envelope: LeaseEnvelope;
  state: string;
  rolloutConfirmed: boolean;
  warnings?: string[];
}

export interface LeaseListParams {
  env?: string;
  json?: boolean;
  offline?: boolean;
  offlineDir?: string;
  apiUrl?: string;
  fetchFn?: typeof fetch;
}

export interface LeaseRevokeParams {
  id: string;
  reason: string;
  kid?: string;
  keyFile?: string;
  password?: string;
  apiUrl?: string;
  fetchFn?: typeof fetch;
}

export interface LeaseRevokeResult {
  leaseId: string;
  state: string;
  envelope: RevocationEnvelope;
}

export interface EmergencyApplyParams {
  env: string;
  flag: string;
  value: unknown;
  reason: string;
  ttl?: number;
  kid?: string;
  keyFile?: string;
  password?: string;
  namespace?: string;
  outFile?: string;
  apply?: boolean;
  emergencyDir?: string;
}

export interface EmergencyApplyResult {
  envelope: LeaseEnvelope;
  yaml: string;
  filePath?: string;
}

/**
 * Parses an override value from CLI argument into typed boolean, number, JSON object, array, or string.
 */
export function parseOverrideValue(
  raw: unknown,
): boolean | number | string | Record<string, unknown> | unknown[] {
  if (typeof raw !== "string") {
    return raw as boolean | number | Record<string, unknown> | unknown[];
  }

  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // JSON Object or Array
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fallback to string if JSON parsing fails
    }
  }

  // Finite numeric literal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return num;
    }
  }

  return trimmed;
}

/**
 * Resolves operator keyfile and loads active EncryptedKeyfileSigner.
 */
async function resolveSigner(params: {
  kid?: string;
  keyFile?: string;
  password?: string;
}): Promise<{ signer: EncryptedKeyfileSigner; filePath: string }> {
  let filePath: string;

  if (params.keyFile) {
    filePath = path.resolve(params.keyFile);
  } else if (params.kid) {
    validateKid(params.kid);
    filePath = path.join(getDefaultKeysDir(), `${params.kid}.key`);
  } else {
    throw new Error("Either --kid or --key-file must be specified");
  }

  const password =
    params.password ?? process.env.SYNAPSE_KEY_PASSWORD ?? "";

  if (!password || password.trim().length === 0) {
    throw new Error(
      "Passphrase required: provide --password or set SYNAPSE_KEY_PASSWORD environment variable",
    );
  }

  const signer = await EncryptedKeyfileSigner.load({ filePath, password });

  if (params.kid && signer.kid !== params.kid) {
    throw new Error(
      `Keyfile kid "${signer.kid}" does not match requested kid "${params.kid}"`,
    );
  }

  return { signer, filePath };
}

/**
 * Validates TTL duration bounds (1 to 86400 seconds).
 */
function validateTtl(ttl: number): void {
  if (
    typeof ttl !== "number" ||
    Number.isNaN(ttl) ||
    !Number.isInteger(ttl) ||
    ttl <= 0 ||
    ttl > 86400
  ) {
    throw new Error(
      `TTL must be a positive integer between 1 and 86400 seconds (got ${ttl})`,
    );
  }
}

/**
 * Validates environment parameter against allowed charset.
 */
function validateEnv(env: string): void {
  if (!env || typeof env !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(env)) {
    throw new Error(
      `Invalid environment "${env}". Must be 1-64 alphanumeric characters, underscores, or hyphens.`,
    );
  }
}

/**
 * Synchronizes workstation time by querying GET /v1/time from Control API.
 */
async function syncServerTime(
  apiUrl: string,
  fetchFn: typeof fetch,
): Promise<{ serverTimeIso: string; serverTimeMs: number }> {
  const url = `${apiUrl.replace(/\/$/, "")}/v1/time`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to synchronize time with Control API (${res.status}): ${res.statusText}`,
    );
  }

  const data = (await res.json()) as { server_time: string };
  const serverTimeMs = Date.parse(data.server_time);

  if (Number.isNaN(serverTimeMs)) {
    throw new Error(
      `Invalid server_time timestamp returned by Control API: "${data.server_time}"`,
    );
  }

  const localNowMs = Date.now();
  const deltaMs = serverTimeMs - localNowMs;

  if (Math.abs(deltaMs) > 5000) {
    console.warn(
      pc.yellow(
        `[WARN] Workstation clock skewed by ${Math.round(deltaMs / 1000)}s from server; compensating issued_at.`,
      ),
    );
  }

  return { serverTimeIso: data.server_time, serverTimeMs };
}

/**
 * Creates, signs, and posts a new emergency break-glass lease.
 */
export async function executeLeaseCreate(
  params: LeaseCreateParams,
): Promise<LeaseCreateResult> {
  validateEnv(params.env);

  if (!FLAG_KEY_REGEX.test(params.flag)) {
    throw new Error(
      `Invalid flag_key "${params.flag}". Must match ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ (lowercase alphanumeric with hyphens).`,
    );
  }

  if (!params.reason || params.reason.trim().length === 0) {
    throw new Error("Operational reason must not be empty or whitespace");
  }

  const ttl = params.ttl ?? 1800;
  validateTtl(ttl);

  const parsedValue = parseOverrideValue(params.value);
  const { signer } = await resolveSigner(params);

  const apiUrl = (
    params.apiUrl ??
    process.env.SYNAPSE_API_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
  const fetchFn = params.fetchFn ?? fetch;

  // Step 1: Synchronize workstation time with Control API
  const { serverTimeIso, serverTimeMs } = await syncServerTime(apiUrl, fetchFn);

  // Step 2: Construct authoritative LeasePayload
  const leaseId = generateUlid(serverTimeMs);
  const rawPayload: LeasePayload = {
    v: 1,
    lease_id: leaseId,
    env: params.env,
    flag_key: params.flag,
    value: parsedValue,
    reason: params.reason.trim(),
    issued_at: serverTimeIso,
    ttl_seconds: ttl,
    kid: signer.kid,
    nonce: crypto.randomBytes(16).toString("base64url"),
  };

  const payload = LeasePayloadSchema.parse(rawPayload);

  // Step 3: Sign with domain separation prefix (synapsestate/lease/v1\n)
  const canonical = canonicalizeJson(payload);
  const messageBuffer = Buffer.concat([
    Buffer.from(LEASE_DOMAIN_PREFIX, "utf8"),
    Buffer.from(canonical, "utf8"),
  ]);
  const sig = await signer.sign(messageBuffer);

  const envelope: LeaseEnvelope = { payload, sig };

  // Step 4: Submit signed envelope to Control API
  const postUrl = `${apiUrl}/v1/leases`;
  const postRes = await fetchFn(postUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });

  if (!postRes.ok) {
    let errMsg = `Control API error (${postRes.status}): ${postRes.statusText}`;
    try {
      const errBody = (await postRes.json()) as {
        error?: string;
        details?: unknown;
      };
      if (errBody.error) {
        errMsg = `Control API error (${postRes.status}): ${errBody.error}`;
      }
    } catch {
      // ignore
    }
    throw new Error(errMsg);
  }

  const resData = (await postRes.json()) as {
    lease_id: string;
    state: string;
    warnings?: string[];
  };

  // Step 5: Rollout Verification Loop (Poll state feed until active lease appears)
  let rolloutConfirmed = false;
  if (params.wait !== false) {
    const timeoutMs = (params.timeoutSeconds ?? 30) * 1000;
    const pollIntervalMs = params.pollIntervalMs ?? 1000;
    const deadline = Date.now() + timeoutMs;

    console.log(
      pc.cyan(
        `\nPolling state feed to confirm rollout across ${params.env} workloads...`,
      ),
    );

    while (Date.now() < deadline) {
      try {
        const stateUrl = `${apiUrl}/v1/sdk/state?env=${encodeURIComponent(params.env)}&wait=2s`;
        const stateRes = await fetchFn(stateUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
        });

        if (stateRes.ok) {
          const stateData = (await stateRes.json()) as {
            active_leases?: LeaseEnvelope[];
          };
          const match = stateData.active_leases?.some(
            (l) => l.payload.lease_id === leaseId,
          );
          if (match) {
            rolloutConfirmed = true;
            break;
          }
        }
      } catch {
        // Retry on transient poll error
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    if (!rolloutConfirmed) {
      console.warn(
        pc.yellow(
          `[WARN] Rollout verification timed out after ${params.timeoutSeconds ?? 30}s. Lease is recorded in database, but not yet observed in active state delivery.`,
        ),
      );
    }
  }

  // Display SRE Summary
  const expiresAt = new Date(
    serverTimeMs + payload.ttl_seconds * 1000,
  ).toISOString();
  console.log(pc.green(pc.bold("\n✓ Emergency lease created successfully!")));
  console.log(pc.dim("--------------------------------------------------"));
  console.log(`${pc.bold("Lease ID:")}       ${payload.lease_id}`);
  console.log(`${pc.bold("Environment:")}    ${payload.env}`);
  console.log(`${pc.bold("Flag Key:")}       ${payload.flag_key}`);
  console.log(`${pc.bold("Value:")}          ${JSON.stringify(payload.value)}`);
  console.log(
    `${pc.bold("TTL:")}            ${payload.ttl_seconds}s (expires ${expiresAt})`,
  );
  console.log(`${pc.bold("Reason:")}         ${payload.reason}`);
  console.log(`${pc.bold("Signer (kid):")}   ${payload.kid}`);
  console.log(
    `${pc.bold("Rollout:")}        ${rolloutConfirmed ? pc.green("CONFIRMED") : pc.yellow("PENDING / TIMED OUT")}`,
  );
  console.log(pc.dim("--------------------------------------------------\n"));

  if (resData.warnings && resData.warnings.length > 0) {
    for (const w of resData.warnings) {
      console.warn(pc.yellow(`[WARNING] ${w}`));
    }
  }

  return {
    leaseId: payload.lease_id,
    envelope,
    state: resData.state,
    rolloutConfirmed,
    warnings: resData.warnings,
  };
}

/**
 * Lists active leases from Control API or offline emergency directory.
 */
export async function executeLeaseList(
  params: LeaseListParams,
): Promise<string> {
  const env = params.env ?? "prod";
  let activeLeases: LeaseEnvelope[] = [];

  if (params.offline) {
    const offlineDir =
      params.offlineDir ??
      process.env.SYNAPSE_EMERGENCY_LEASES_DIR ??
      "/etc/synapse/emergency-leases";

    try {
      const files = await fs.readdir(offlineDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const content = await fs.readFile(path.join(offlineDir, file), "utf8");
          const parsed = JSON.parse(content) as LeaseEnvelope;
          if (parsed?.payload?.lease_id) {
            if (params.env && parsed.payload.env !== params.env) {
              continue;
            }
            const expiry = evaluateLeaseExpiry({
              issuedAt: parsed.payload.issued_at,
              ttlSeconds: parsed.payload.ttl_seconds,
              firstSeenMonoMs: performance.now(),
            });
            if (expiry.isValid) {
              activeLeases.push(parsed);
            }
          }
        } catch {
          // ignore corrupted or non-lease files
        }
      }
    } catch {
      // offline directory unreadable or does not exist
    }
  } else {
    const apiUrl = (
      params.apiUrl ??
      process.env.SYNAPSE_API_URL ??
      "http://localhost:3000"
    ).replace(/\/$/, "");
    const fetchFn = params.fetchFn ?? fetch;

    const url = `${apiUrl}/v1/sdk/state?env=${encodeURIComponent(env)}&wait=0`;
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      throw new Error(
        `Failed to fetch state from Control API (${res.status}): ${res.statusText}`,
      );
    }

    const data = (await res.json()) as { active_leases?: LeaseEnvelope[] };
    activeLeases = data.active_leases ?? [];
  }

  if (params.json) {
    return JSON.stringify(activeLeases, null, 2);
  }

  if (activeLeases.length === 0) {
    return pc.dim(
      `No active emergency leases found for environment "${env}".`,
    );
  }

  const table = new Table({
    head: [
      pc.bold("Lease ID"),
      pc.bold("Env"),
      pc.bold("Flag Key"),
      pc.bold("Value"),
      pc.bold("Remaining TTL"),
      pc.bold("Reason"),
      pc.bold("Signer (kid)"),
      pc.bold("Issued At"),
    ],
    style: { head: [], border: [] },
  });

  const nowMs = Date.now();
  for (const lease of activeLeases) {
    const issuedMs = Date.parse(lease.payload.issued_at);
    const expiresMs = issuedMs + lease.payload.ttl_seconds * 1000;
    const remainingSec = Math.max(0, Math.floor((expiresMs - nowMs) / 1000));

    let remainingStr: string;
    if (remainingSec === 0) {
      remainingStr = pc.red("EXPIRED");
    } else if (remainingSec < 300) {
      remainingStr = pc.yellow(`${Math.floor(remainingSec / 60)}m ${remainingSec % 60}s`);
    } else {
      remainingStr = pc.green(`${Math.floor(remainingSec / 60)}m ${remainingSec % 60}s`);
    }

    table.push([
      pc.cyan(lease.payload.lease_id),
      lease.payload.env,
      lease.payload.flag_key,
      JSON.stringify(lease.payload.value),
      remainingStr,
      lease.payload.reason,
      lease.payload.kid,
      lease.payload.issued_at,
    ]);
  }

  return table.toString();
}

/**
 * Revokes an active emergency lease by ID.
 */
export async function executeLeaseRevoke(
  params: LeaseRevokeParams,
): Promise<LeaseRevokeResult> {
  if (!ULID_REGEX.test(params.id)) {
    throw new Error(
      `Invalid lease_id "${params.id}". Must be a valid 26-character Crockford ULID.`,
    );
  }

  if (!params.reason || params.reason.trim().length === 0) {
    throw new Error("Operational reason must not be empty or whitespace");
  }

  const { signer } = await resolveSigner(params);

  const rawRevocation: RevocationPayload = {
    v: 1,
    lease_id: params.id,
    revoked_at: new Date().toISOString(),
    kid: signer.kid,
    reason: params.reason.trim(),
  };

  const payload = RevocationPayloadSchema.parse(rawRevocation);

  const canonical = canonicalizeJson(payload);
  const messageBuffer = Buffer.concat([
    Buffer.from(REVOCATION_DOMAIN_PREFIX, "utf8"),
    Buffer.from(canonical, "utf8"),
  ]);
  const sig = await signer.sign(messageBuffer);

  const envelope: RevocationEnvelope = { payload, sig };

  const apiUrl = (
    params.apiUrl ??
    process.env.SYNAPSE_API_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
  const fetchFn = params.fetchFn ?? fetch;

  const url = `${apiUrl}/v1/leases/${encodeURIComponent(params.id)}/revoke`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });

  if (!res.ok) {
    let errMsg = `Control API error (${res.status}): ${res.statusText}`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody.error) {
        errMsg = `Control API error (${res.status}): ${errBody.error}`;
      }
    } catch {
      // ignore
    }
    throw new Error(errMsg);
  }

  console.log(pc.green(pc.bold(`\n✓ Lease ${params.id} revoked successfully!`)));
  console.log(pc.dim("--------------------------------------------------"));
  console.log(`${pc.bold("Lease ID:")}       ${params.id}`);
  console.log(`${pc.bold("Revoked At:")}     ${payload.revoked_at}`);
  console.log(`${pc.bold("Reason:")}         ${payload.reason}`);
  console.log(`${pc.bold("Revoked By:")}     ${payload.kid}`);
  console.log(pc.dim("--------------------------------------------------\n"));

  return {
    leaseId: params.id,
    state: "REVOKED",
    envelope,
  };
}

/**
 * Generates an air-gapped emergency lease ConfigMap for offline kubectl apply.
 */
export async function executeLeaseEmergencyApply(
  params: EmergencyApplyParams,
): Promise<EmergencyApplyResult> {
  validateEnv(params.env);

  if (!FLAG_KEY_REGEX.test(params.flag)) {
    throw new Error(
      `Invalid flag_key "${params.flag}". Must match ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ (lowercase alphanumeric with hyphens).`,
    );
  }

  if (!params.reason || params.reason.trim().length === 0) {
    throw new Error("Operational reason must not be empty or whitespace");
  }

  const ttl = params.ttl ?? 1800;
  validateTtl(ttl);

  const parsedValue = parseOverrideValue(params.value);
  const { signer } = await resolveSigner(params);

  const leaseId = generateUlid();
  const rawPayload: LeasePayload = {
    v: 1,
    lease_id: leaseId,
    env: params.env,
    flag_key: params.flag,
    value: parsedValue,
    reason: params.reason.trim(),
    issued_at: new Date().toISOString(),
    ttl_seconds: ttl,
    kid: signer.kid,
    nonce: crypto.randomBytes(16).toString("base64url"),
  };

  const payload = LeasePayloadSchema.parse(rawPayload);

  const canonical = canonicalizeJson(payload);
  const messageBuffer = Buffer.concat([
    Buffer.from(LEASE_DOMAIN_PREFIX, "utf8"),
    Buffer.from(canonical, "utf8"),
  ]);
  const sig = await signer.sign(messageBuffer);

  const envelope: LeaseEnvelope = { payload, sig };

  const namespace = params.namespace ?? "default";
  const configMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `synapse-emergency-lease-${leaseId.toLowerCase()}`,
      namespace,
      labels: {
        "synapse.io/lease": "true",
      },
    },
    data: {
      [`${leaseId}.json`]: JSON.stringify(envelope, null, 2),
    },
  };

  const yamlOutput = YAML.stringify(configMap);

  let writtenPath: string | undefined;
  if (params.outFile) {
    writtenPath = path.resolve(params.outFile);
    await fs.mkdir(path.dirname(writtenPath), { recursive: true });
    await fs.writeFile(writtenPath, yamlOutput, "utf8");
    console.log(pc.green(`✓ Kubernetes ConfigMap written to: ${writtenPath}`));
  }

  if (params.apply) {
    const emergencyDir =
      params.emergencyDir ??
      process.env.SYNAPSE_EMERGENCY_LEASES_DIR ??
      "/etc/synapse/emergency-leases";
    await fs.mkdir(emergencyDir, { recursive: true });
    writtenPath = path.join(emergencyDir, `${leaseId}.json`);
    await fs.writeFile(
      writtenPath,
      JSON.stringify(envelope, null, 2) + "\n",
      "utf8",
    );
    console.log(
      pc.green(`✓ Emergency lease applied directly to node: ${writtenPath}`),
    );
  }

  return {
    envelope,
    yaml: yamlOutput,
    filePath: writtenPath,
  };
}

/**
 * Registers `synapse lease create`, `list`, `revoke`, and `emergency-apply` subcommands.
 */
export function registerLeaseCommands(program: Command): void {
  const lease = program
    .command("lease")
    .description("Manage emergency break-glass leases and air-gapped overrides");

  lease
    .command("create")
    .description(
      "Create and submit a signed emergency break-glass lease with server time synchronization",
    )
    .requiredOption("-e, --env <env>", "Target environment (e.g. prod, staging)")
    .requiredOption("-f, --flag <key>", "Feature flag key (e.g. checkout-v2)")
    .requiredOption("-v, --value <val>", "Override value (true, false, number, or JSON)")
    .requiredOption("-r, --reason <text>", "Mandatory operational incident justification")
    .option(
      "-t, --ttl <seconds>",
      "Lease lifetime in seconds (default: 1800, max: 86400)",
      (v) => parseInt(v, 10),
      1800,
    )
    .option("-k, --kid <kid>", "Key identifier to sign the lease (e.g. alice-oncall-sre)")
    .option("--key-file <path>", "Direct path to encrypted .key file")
    .option(
      "-p, --password <pass>",
      "Passphrase for keyfile decryption (defaults to SYNAPSE_KEY_PASSWORD env var)",
    )
    .option(
      "--api-url <url>",
      "Control API base URL (default: http://localhost:3000 or SYNAPSE_API_URL)",
    )
    .option(
      "--no-wait",
      "Do not poll state feed for rollout verification confirmation",
    )
    .option(
      "--timeout <seconds>",
      "Rollout verification timeout in seconds (default: 30)",
      (v) => parseInt(v, 10),
      30,
    )
    .action(async (opts) => {
      try {
        await executeLeaseCreate({
          env: opts.env,
          flag: opts.flag,
          value: opts.value,
          reason: opts.reason,
          ttl: opts.ttl,
          kid: opts.kid,
          keyFile: opts.keyFile,
          password: opts.password,
          apiUrl: opts.apiUrl,
          wait: opts.wait,
          timeoutSeconds: opts.timeout,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`Error: ${message}`));
        process.exitCode = 1;
      }
    });

  lease
    .command("list")
    .description("List active emergency leases from Control API or offline emergency directory")
    .option("-e, --env <env>", "Target environment filter (default: prod)", "prod")
    .option("--json", "Output machine-readable JSON array", false)
    .option("--offline", "Read from local emergency-leases directory instead of Control API", false)
    .option(
      "--offline-dir <dir>",
      "Directory for offline emergency leases (default: /etc/synapse/emergency-leases)",
    )
    .option(
      "--api-url <url>",
      "Control API base URL (default: http://localhost:3000 or SYNAPSE_API_URL)",
    )
    .action(async (opts) => {
      try {
        const output = await executeLeaseList({
          env: opts.env,
          json: opts.json,
          offline: opts.offline,
          offlineDir: opts.offlineDir,
          apiUrl: opts.apiUrl,
        });
        console.log(output);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`Error: ${message}`));
        process.exitCode = 1;
      }
    });

  lease
    .command("revoke")
    .description("Revoke an active emergency lease by ID")
    .requiredOption("-i, --id <lease_id>", "Lease identifier (26-character Crockford ULID)")
    .requiredOption("-r, --reason <text>", "Operational reason for revocation")
    .option("-k, --kid <kid>", "Key identifier used to sign the revocation")
    .option("--key-file <path>", "Direct path to encrypted .key file")
    .option(
      "-p, --password <pass>",
      "Passphrase for keyfile decryption (defaults to SYNAPSE_KEY_PASSWORD env var)",
    )
    .option(
      "--api-url <url>",
      "Control API base URL (default: http://localhost:3000 or SYNAPSE_API_URL)",
    )
    .action(async (opts) => {
      try {
        await executeLeaseRevoke({
          id: opts.id,
          reason: opts.reason,
          kid: opts.kid,
          keyFile: opts.keyFile,
          password: opts.password,
          apiUrl: opts.apiUrl,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`Error: ${message}`));
        process.exitCode = 1;
      }
    });

  lease
    .command("emergency-apply")
    .description(
      "Generate signed Kubernetes ConfigMap YAML or apply directly to node during Control API outage",
    )
    .requiredOption("-e, --env <env>", "Target environment (e.g. prod, staging)")
    .requiredOption("-f, --flag <key>", "Feature flag key (e.g. checkout-v2)")
    .requiredOption("-v, --value <val>", "Override value (true, false, number, or JSON)")
    .requiredOption("-r, --reason <text>", "Mandatory operational incident justification")
    .option(
      "-t, --ttl <seconds>",
      "Lease lifetime in seconds (default: 1800, max: 86400)",
      (v) => parseInt(v, 10),
      1800,
    )
    .option("-k, --kid <kid>", "Key identifier to sign the lease")
    .option("--key-file <path>", "Direct path to encrypted .key file")
    .option(
      "-p, --password <pass>",
      "Passphrase for keyfile decryption (defaults to SYNAPSE_KEY_PASSWORD env var)",
    )
    .option("-n, --namespace <ns>", "Kubernetes namespace (default: default)", "default")
    .option("-o, --out-file <path>", "Output file path for generated ConfigMap YAML")
    .option("--apply", "Write directly to local emergency directory", false)
    .option(
      "--emergency-dir <dir>",
      "Directory for emergency leases (default: /etc/synapse/emergency-leases)",
    )
    .action(async (opts) => {
      try {
        const res = await executeLeaseEmergencyApply({
          env: opts.env,
          flag: opts.flag,
          value: opts.value,
          reason: opts.reason,
          ttl: opts.ttl,
          kid: opts.kid,
          keyFile: opts.keyFile,
          password: opts.password,
          namespace: opts.namespace,
          outFile: opts.outFile,
          apply: opts.apply,
          emergencyDir: opts.emergencyDir,
        });
        if (!opts.outFile && !opts.apply) {
          console.log(res.yaml);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`Error: ${message}`));
        process.exitCode = 1;
      }
    });
}
