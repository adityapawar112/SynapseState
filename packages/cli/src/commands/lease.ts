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
  DEFAULT_SKEW_TOLERANCE_MS,
  generateUlid,
  evaluateLeaseExpiry,
  signLeaseWithSigner,
  signRevocationWithSigner,
  LeasePayloadSchema,
  RevocationPayloadSchema,
  LeaseEnvelopeSchema,
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
  passphraseEnv?: string;
  apiUrl?: string;
  wait?: boolean;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
  allowSkewMs?: number;
  maxRttMs?: number;
  fetchFn?: typeof fetch;
}

export interface LeaseCreateResult {
  leaseId: string;
  envelope: LeaseEnvelope;
  state: string;
  rolloutConfirmed: boolean;
  rttMs?: number;
  deltaMs?: number;
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
  passphraseEnv?: string;
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
  passphraseEnv?: string;
  namespace?: string;
  outFile?: string;
  apply?: boolean;
  emergencyDir?: string;
}

export interface EmergencyApplyResult {
  envelope: LeaseEnvelope;
  yaml: string;
  configMap: Record<string, unknown>;
  filePath?: string;
  writtenPath?: string;
  appliedPath?: string;
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

  // Finite numeric literal (supports integer, decimal, exponential e.g. 1e3, +5, .5)
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
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
  passphraseEnv?: string;
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

  let password = "";
  if (params.passphraseEnv && process.env[params.passphraseEnv]) {
    password = process.env[params.passphraseEnv]!;
  } else if (params.password) {
    console.warn(
      pc.yellow(
        "[WARN] Supplying passphrase via --password flag can expose secrets in process lists and shell history. Consider using SYNAPSE_KEY_PASSWORD or --passphrase-env.",
      ),
    );
    password = params.password;
  } else if (process.env.SYNAPSE_KEY_PASSWORD) {
    password = process.env.SYNAPSE_KEY_PASSWORD;
  }

  if (!password || password.trim().length === 0) {
    throw new Error(
      "Passphrase required: provide --passphrase-env, set SYNAPSE_KEY_PASSWORD environment variable, or use --password",
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
 * Measures round-trip time (RTT), estimates symmetric one-way latency, and enforces skew bounds.
 */
export async function syncServerTime(
  apiUrl: string,
  fetchFn: typeof fetch,
  options?: { maxRttMs?: number; allowSkewMs?: number },
): Promise<{
  serverTimeIso: string;
  serverTimeMs: number;
  rttMs: number;
  deltaMs: number;
}> {
  const url = `${apiUrl.replace(/\/$/, "")}/v1/time`;
  const t0 = Date.now();
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to synchronize time with Control API (${res.status}): ${res.statusText}`,
    );
  }

  const t1 = Date.now();
  const rttMs = t1 - t0;
  const maxRtt = options?.maxRttMs ?? 5000;
  if (rttMs > maxRtt) {
    throw new Error(
      `Clock sync RTT ${rttMs}ms exceeds ${maxRtt}ms budget; aborting (check network/NTP).`,
    );
  }

  const data = (await res.json()) as { server_time: string };
  const serverTimeMs = Date.parse(data.server_time);

  if (Number.isNaN(serverTimeMs)) {
    throw new Error(
      `Invalid server_time timestamp returned by Control API: "${data.server_time}"`,
    );
  }

  // Assume symmetric network delay; compensate server time by half RTT
  const adjustedServerMs = serverTimeMs + Math.floor(rttMs / 2);
  const deltaMs = adjustedServerMs - t1;
  const maxSkewMs = options?.allowSkewMs ?? DEFAULT_SKEW_TOLERANCE_MS;

  if (Math.abs(deltaMs) > maxSkewMs) {
    throw new Error(
      `Clock skew ${deltaMs}ms exceeds ${maxSkewMs}ms tolerance; aborting. Fix NTP or pass --allow-skew=<ms>.`,
    );
  }

  if (Math.abs(deltaMs) > 5000) {
    console.warn(
      pc.yellow(
        `[WARN] Workstation clock skewed by ${Math.round(deltaMs / 1000)}s from server; compensating issued_at.`,
      ),
    );
  }

  return {
    serverTimeIso: new Date(adjustedServerMs).toISOString(),
    serverTimeMs: adjustedServerMs,
    rttMs,
    deltaMs,
  };
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
  const { serverTimeIso, serverTimeMs, rttMs, deltaMs } = await syncServerTime(
    apiUrl,
    fetchFn,
    {
      maxRttMs: params.maxRttMs,
      allowSkewMs: params.allowSkewMs,
    },
  );

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
  const envelope = await signLeaseWithSigner(payload, signer);

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
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const controller = new AbortController();
      const timeoutTimer = setTimeout(
        () => controller.abort(),
        Math.min(2000, remaining),
      );

      try {
        const waitS = Math.max(1, Math.min(2, Math.floor(remaining / 1000)));
        const stateUrl = `${apiUrl}/v1/sdk/state?env=${encodeURIComponent(params.env)}&wait=${waitS}s`;
        const stateRes = await fetchFn(stateUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal as AbortSignal,
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
        } else if (
          stateRes.status === 400 ||
          stateRes.status === 401 ||
          stateRes.status === 403
        ) {
          const body = await stateRes.text().catch(() => "");
          throw new Error(
            `Rollout verification aborted: Control API returned ${stateRes.status}: ${body.slice(0, 200)}`,
          );
        }
        // Other statuses (e.g. 5xx, 304): retry transiently
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.message.startsWith("Rollout verification aborted")
        ) {
          throw err;
        }
        // Ignore transient fetch/abort errors during poll iteration
      } finally {
        clearTimeout(timeoutTimer);
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
    rttMs,
    deltaMs,
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
          const parsedJson = JSON.parse(content);
          const parseResult = LeaseEnvelopeSchema.safeParse(parsedJson);
          if (parseResult.success) {
            const envelope = parseResult.data;
            if (params.env && envelope.payload.env !== params.env) {
              continue;
            }
            const expiry = evaluateLeaseExpiry({
              issuedAt: envelope.payload.issued_at,
              ttlSeconds: envelope.payload.ttl_seconds,
              firstSeenMonoMs: performance.now(),
            });
            if (expiry.isValid) {
              activeLeases.push(envelope);
            }
          }
        } catch {
          // ignore corrupted or unreadable files
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

  const nowWall = Date.now();
  const nowMono = performance.now();
  for (const lease of activeLeases) {
    // In CLI listing, firstSeenMonoMs is initialized to nowMono so that wall-clock
    // expiry and skew grace bounds dominate, since the CLI has no persistent process incarnation.
    const eval_ = evaluateLeaseExpiry({
      issuedAt: lease.payload.issued_at,
      ttlSeconds: lease.payload.ttl_seconds,
      firstSeenMonoMs: nowMono,
      nowWallMs: nowWall,
      nowMonoMs: nowMono,
    });

    const remainingSec = Math.max(
      0,
      Math.floor(eval_.remainingEffectiveMs / 1000),
    );

    let remainingStr: string;
    if (!eval_.isValid) {
      remainingStr = pc.red(eval_.status);
    } else if (remainingSec < 300) {
      remainingStr = pc.yellow(
        `${Math.floor(remainingSec / 60)}m ${remainingSec % 60}s`,
      );
    } else {
      remainingStr = pc.green(
        `${Math.floor(remainingSec / 60)}m ${remainingSec % 60}s`,
      );
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
  const envelope = await signRevocationWithSigner(payload, signer);

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
  console.warn(
    pc.yellow(
      "[WARN] emergency-apply uses local workstation clock (no /v1/time available during outage). If this host is >30s fast, SDKs will reject the lease as FUTURE_DATED. Verify host clock with 'date -u'.",
    ),
  );

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
  const envelope = await signLeaseWithSigner(payload, signer);

  const namespace = params.namespace ?? "default";
  if (
    namespace.length > 63 ||
    !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)
  ) {
    throw new Error(
      `Invalid Kubernetes namespace "${namespace}". Must be a valid DNS-1123 label (lowercase alphanumeric and hyphens, max 63 characters).`,
    );
  }

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

  let appliedPath: string | undefined;
  if (params.apply) {
    const emergencyDir =
      params.emergencyDir ??
      process.env.SYNAPSE_EMERGENCY_LEASES_DIR ??
      "/etc/synapse/emergency-leases";
    await fs.mkdir(emergencyDir, { recursive: true });
    appliedPath = path.join(emergencyDir, `${leaseId}.json`);
    await fs.writeFile(
      appliedPath,
      JSON.stringify(envelope, null, 2) + "\n",
      "utf8",
    );
    console.log(
      pc.green(`✓ Emergency lease applied directly to node: ${appliedPath}`),
    );
  }

  return {
    envelope,
    yaml: yamlOutput,
    configMap,
    filePath: writtenPath ?? appliedPath,
    writtenPath,
    appliedPath,
  };
}

/**
 * Validates integer options with minimum and maximum bounds.
 */
function parseIntegerOption(
  val: string,
  flagName: string,
  min: number,
  max: number,
): number {
  const parsed = parseInt(val, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Option ${flagName} must be an integer between ${min} and ${max} (got "${val}")`,
    );
  }
  return parsed;
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
    .option("-v, --value <val>", "Override value (true, false, number, or JSON)")
    .option("--variant <variant>", "Alias for --value")
    .requiredOption("-r, --reason <text>", "Mandatory operational incident justification")
    .option(
      "-t, --ttl <seconds>",
      "Lease lifetime in seconds (default: 1800, max: 86400)",
      (v) => parseIntegerOption(v, "--ttl", 1, 86400),
      1800,
    )
    .option("-k, --kid <kid>", "Key identifier to sign the lease (e.g. alice-oncall-sre)")
    .option("--key-file <path>", "Direct path to encrypted .key file")
    .option(
      "-p, --password <pass>",
      "Passphrase for keyfile decryption (defaults to SYNAPSE_KEY_PASSWORD env var)",
    )
    .option(
      "--passphrase-env <var>",
      "Environment variable name containing the keyfile passphrase",
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
      "Rollout verification timeout in seconds (default: 30, max: 600)",
      (v) => parseIntegerOption(v, "--timeout", 1, 600),
      30,
    )
    .option(
      "--poll-interval <ms>",
      "State polling interval in ms (default: 1000, min: 100, max: 10000)",
      (v) => parseIntegerOption(v, "--poll-interval", 100, 10000),
      1000,
    )
    .option(
      "--allow-skew <ms>",
      "Permitted clock skew in ms (default: 30000, max: 300000)",
      (v) => parseIntegerOption(v, "--allow-skew", 0, 300000),
      30000,
    )
    .action(async (opts) => {
      try {
        const rawValue = opts.value ?? opts.variant;
        if (rawValue === undefined) {
          throw new Error("error: required option '-v, --value <val>' (or '--variant <val>') not specified");
        }
        const res = await executeLeaseCreate({
          env: opts.env,
          flag: opts.flag,
          value: rawValue,
          reason: opts.reason,
          ttl: opts.ttl,
          kid: opts.kid,
          keyFile: opts.keyFile,
          password: opts.password,
          passphraseEnv: opts.passphraseEnv,
          apiUrl: opts.apiUrl,
          wait: opts.wait,
          timeoutSeconds: opts.timeout,
          pollIntervalMs: opts.pollInterval,
          allowSkewMs: opts.allowSkew,
        });

        if (opts.wait !== false && !res.rolloutConfirmed) {
          process.exitCode = 2; // Submitted to DB, but rollout unconfirmed
        }
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
      "--passphrase-env <var>",
      "Environment variable name containing the keyfile passphrase",
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
          passphraseEnv: opts.passphraseEnv,
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
      (v) => parseIntegerOption(v, "--ttl", 1, 86400),
      1800,
    )
    .option("-k, --kid <kid>", "Key identifier to sign the lease")
    .option("--key-file <path>", "Direct path to encrypted .key file")
    .option(
      "-p, --password <pass>",
      "Passphrase for keyfile decryption (defaults to SYNAPSE_KEY_PASSWORD env var)",
    )
    .option(
      "--passphrase-env <var>",
      "Environment variable name containing the keyfile passphrase",
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
          passphraseEnv: opts.passphraseEnv,
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
