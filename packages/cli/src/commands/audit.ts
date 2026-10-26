import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pc from "picocolors";
import type { Command } from "commander";
import pg from "pg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  GENESIS_PREV_HASH,
  verifyAuditChain,
  signCheckpoint,
  signCheckpointWithSigner,
  verifyCheckpointWithKeyset,
  parseKeysetJson,
  resolvePublicKey,
  resolvePrivateKey,
  formatPublicKeyToHex,
  CheckpointEnvelopeSchema,
  type AuditEventRecord,
  type CheckpointPayload,
  type CheckpointEnvelope,
  type Keyset,
  getKey,
  canSignCheckpoint,
} from "@synapsestate/lease";
import { EncryptedKeyfileSigner } from "../signer/encrypted-file.js";

const { Pool } = pg;

export interface AuditVerifyParams {
  file?: string;
  apiUrl?: string;
  token?: string;
  db?: string;
  checkpoint?: string;
  keyset?: string;
  json?: boolean;
  fetchFn?: typeof fetch;
  pgPool?: pg.Pool;
}

export type CheckpointAnchorStatus =
  | "VALIDATED"
  | "NO_CHECKPOINT"
  | "MISMATCH"
  | "INVALID_SIGNATURE"
  | "UNAUTHORIZED_SIGNER"
  | "UNKNOWN_KEY";

export interface AuditVerifyResult {
  valid: boolean;
  verifiedCount: number;
  fromSeq: number;
  toSeq: number;
  genesisPrevHash: string;
  latestHash: string;
  checkpoint?: {
    status: CheckpointAnchorStatus;
    seq?: number;
    hash?: string;
    kid?: string;
    error?: string;
  };
  error?: string;
  failedSeq?: number;
  elapsedMs: number;
  formattedOutput: string;
}

export interface AuditCheckpointParams {
  apiUrl?: string;
  token?: string;
  db?: string;
  kid?: string;
  key?: string;
  keyFile?: string;
  password?: string;
  passphraseEnv?: string;
  keyset?: string;
  out?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Prefix?: string;
  s3ObjectLock?: boolean;
  json?: boolean;
  fetchFn?: typeof fetch;
  pgPool?: pg.Pool;
  s3Client?: { send: (cmd: unknown) => Promise<unknown> };
}

export interface AuditCheckpointResult {
  envelope: CheckpointEnvelope;
  savedTo?: string[];
  formattedOutput: string;
}

/**
 * Loads and parses audit events from JSON or JSONL file.
 */
async function loadEventsFromFile(
  filePath: string,
): Promise<AuditEventRecord[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  // Attempt standard JSON array
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed as AuditEventRecord[];
      }
    } catch {
      // Fall through to JSONL parsing
    }
  }

  // Attempt newline-delimited JSON (JSONL)
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events: AuditEventRecord[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line.trim());
    events.push(parsed as AuditEventRecord);
  }
  return events;
}

/**
 * Loads audit events sequentially from Control API across multiple pages.
 */
async function loadEventsFromApi(
  apiUrl: string,
  token?: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuditEventRecord[]> {
  const cleanUrl = apiUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const allEvents: AuditEventRecord[] = [];
  let fromSeq = 1;
  const limit = 1000;
  let hasMore = true;

  while (hasMore) {
    const url = `${cleanUrl}/v1/audit/events?from_seq=${fromSeq}&limit=${limit}`;
    const res = await fetchFn(url, { headers });
    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(
        `Control API error (${res.status} ${res.statusText}): ${errorText}`,
      );
    }

    const data = (await res.json()) as {
      events: AuditEventRecord[];
      count: number;
      total: number;
      has_more: boolean;
    };

    if (!data.events || data.events.length === 0) {
      break;
    }

    allEvents.push(...data.events);
    hasMore = Boolean(data.has_more);
    if (hasMore) {
      const lastSeq = Number(data.events[data.events.length - 1]!.seq);
      fromSeq = lastSeq + 1;
    }
  }

  return allEvents;
}

/**
 * Loads audit events directly from PostgreSQL database.
 */
async function loadEventsFromDb(
  poolOrConnectionString?: pg.Pool | string,
): Promise<AuditEventRecord[]> {
  let pool: pg.Pool;
  let isCreated = false;

  if (poolOrConnectionString && typeof poolOrConnectionString !== "string") {
    pool = poolOrConnectionString;
  } else {
    const connectionString =
      (typeof poolOrConnectionString === "string"
        ? poolOrConnectionString
        : undefined) || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "No database connection string provided. Specify --db or set DATABASE_URL.",
      );
    }
    pool = new Pool({ connectionString });
    isCreated = true;
  }

  try {
    const query =
      "SELECT seq, ts, actor, event_type, payload, prev_hash, hash FROM audit_events ORDER BY seq ASC";
    const res = await pool.query<AuditEventRecord>(query);
    return res.rows.map((row) => ({
      ...row,
      seq: Number(row.seq),
      ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    }));
  } finally {
    if (isCreated) {
      await pool.end();
    }
  }
}

/**
 * Loads trusted keyset from explicit path or environment variable.
 */
async function loadKeyset(explicitPath?: string): Promise<Keyset | null> {
  const keysetPath =
    explicitPath ||
    process.env.KEYSET_PATH ||
    path.resolve(process.cwd(), "keyset.json");

  try {
    const content = await fs.readFile(keysetPath, "utf-8");
    return parseKeysetJson(content);
  } catch (err: unknown) {
    if (explicitPath) {
      throw new Error(
        `Failed to load trusted keyset at "${keysetPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
}

/**
 * Loads checkpoint envelope from file or HTTP URL and validates its schema via CheckpointEnvelopeSchema.
 */
async function loadCheckpoint(
  checkpointPathOrUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<CheckpointEnvelope> {
  let rawJson: unknown;
  if (
    checkpointPathOrUrl.startsWith("http://") ||
    checkpointPathOrUrl.startsWith("https://")
  ) {
    const res = await fetchFn(checkpointPathOrUrl);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch checkpoint from URL: ${res.status} ${res.statusText}`,
      );
    }
    rawJson = await res.json();
  } else {
    const raw = await fs.readFile(checkpointPathOrUrl, "utf-8");
    rawJson = JSON.parse(raw);
  }

  // Invariant & I3: Validate envelope structure, fields, and types via Zod schema
  return CheckpointEnvelopeSchema.parse(rawJson);
}

/**
 * SRE CLI engine: synapse audit verify
 * Independently recomputes SHA-256 hash chain from genesis and cross-verifies external checkpoints.
 */
export async function executeAuditVerify(
  params: AuditVerifyParams,
): Promise<AuditVerifyResult> {
  const startTime = Date.now();

  // 1. Load audit event records
  let events: AuditEventRecord[] = [];
  if (params.file) {
    events = await loadEventsFromFile(params.file);
  } else if (params.pgPool || params.db) {
    events = await loadEventsFromDb(params.pgPool || params.db);
  } else if (params.apiUrl || process.env.SYNAPSE_API_URL) {
    const apiUrl = params.apiUrl || process.env.SYNAPSE_API_URL!;
    const token = params.token || process.env.SYNAPSE_API_TOKEN;
    events = await loadEventsFromApi(apiUrl, token, params.fetchFn);
  } else if (process.env.DATABASE_URL) {
    events = await loadEventsFromDb(process.env.DATABASE_URL);
  } else {
    // Default to local API URL
    const apiUrl = "http://localhost:3000";
    const token = params.token || process.env.SYNAPSE_API_TOKEN;
    events = await loadEventsFromApi(apiUrl, token, params.fetchFn);
  }

  // 2. Invariant 7: Zero trust in stored hashes — re-verify entire chain from genesis
  const chainResult = verifyAuditChain(events, GENESIS_PREV_HASH);

  const verifiedCount = events.length;
  const fromSeq = verifiedCount > 0 ? Number(events[0]!.seq) : 0;
  const toSeq = verifiedCount > 0 ? Number(events[verifiedCount - 1]!.seq) : 0;
  const latestHash =
    verifiedCount > 0
      ? String(events[verifiedCount - 1]!.hash)
      : GENESIS_PREV_HASH;

  let checkpointStatus: CheckpointAnchorStatus = "NO_CHECKPOINT";
  let checkpointSeq: number | undefined;
  let checkpointHash: string | undefined;
  let checkpointKid: string | undefined;
  let checkpointError: string | undefined;

  let overallValid = chainResult.valid;
  let failureError = chainResult.error;
  let failedSeq = chainResult.failedSeq;

  // Invariant 7 (C1): Enforce that verified ledger starts at genesis seq 1
  if (overallValid && verifiedCount > 0 && fromSeq !== 1) {
    overallValid = false;
    failureError = `Ledger starts at seq ${fromSeq}, not genesis seq 1 (prefix truncation or partial export)`;
    failedSeq = fromSeq;
  }

  // 3. Invariant 2: External Checkpoint verification against trusted keyset
  if (params.checkpoint) {
    try {
      const envelope = await loadCheckpoint(params.checkpoint, params.fetchFn);
      checkpointSeq = envelope.payload?.checkpoint_seq;
      checkpointHash = envelope.payload?.checkpoint_hash;
      checkpointKid = envelope.payload?.kid;

      const keyset = await loadKeyset(params.keyset);
      if (!keyset) {
        checkpointStatus = "UNKNOWN_KEY";
        checkpointError = "Trusted keyset not found or malformed";
        overallValid = false;
        failureError = failureError || checkpointError;
      } else {
        const key = getKey(keyset, checkpointKid);
        if (!key) {
          checkpointStatus = "UNKNOWN_KEY";
          checkpointError = `Signer key "${checkpointKid}" not found in trusted keyset`;
          overallValid = false;
          failureError = failureError || checkpointError;
        } else if (!canSignCheckpoint(key)) {
          checkpointStatus = "UNAUTHORIZED_SIGNER";
          checkpointError = `Key "${checkpointKid}" lacks checkpoint_signer, audit_signer, or admin role`;
          overallValid = false;
          failureError = failureError || checkpointError;
        } else {
          const isSigValid = verifyCheckpointWithKeyset(envelope, keyset);
          if (!isSigValid) {
            checkpointStatus = "INVALID_SIGNATURE";
            checkpointError =
              "Checkpoint Ed25519 signature is invalid or corrupted";
            overallValid = false;
            failureError = failureError || checkpointError;
          } else {
            // Checkpoint signature is cryptographically valid! Cross-verify with event chain
            const targetEvent = events.find(
              (e) => Number(e.seq) === checkpointSeq,
            );
            if (!targetEvent) {
              checkpointStatus = "MISMATCH";
              checkpointError = `Checkpoint sequence ${checkpointSeq} not found in verified ledger range (${fromSeq} → ${toSeq})`;
              overallValid = false;
              failureError = failureError || checkpointError;
            } else if (targetEvent.hash !== checkpointHash) {
              checkpointStatus = "MISMATCH";
              checkpointError = `Checkpoint hash mismatch at seq ${checkpointSeq}: expected "${checkpointHash}", ledger has "${targetEvent.hash}"`;
              overallValid = false;
              failureError = failureError || checkpointError;
              failedSeq = checkpointSeq;
            } else {
              checkpointStatus = "VALIDATED";
            }
          }
        }
      }
    } catch (err: unknown) {
      checkpointStatus = "INVALID_SIGNATURE";
      checkpointError = `Failed to validate checkpoint envelope schema: ${err instanceof Error ? err.message : String(err)}`;
      overallValid = false;
      failureError = failureError || checkpointError;
    }
  }

  const elapsedMs = Date.now() - startTime;

  // 4. Format styled terminal status box
  let statusHeader: string;
  let rawHeader: string;
  if (!overallValid) {
    statusHeader = pc.red(
      pc.bold("✖ AUDIT LEDGER VERIFICATION: FAILED (TAMPERING DETECTED)"),
    );
    rawHeader = "✖ AUDIT LEDGER VERIFICATION: FAILED (TAMPERING DETECTED)";
  } else if (verifiedCount === 0) {
    statusHeader = pc.yellow(
      pc.bold("⚠ AUDIT LEDGER VERIFICATION: NO EVENTS (EMPTY LEDGER)"),
    );
    rawHeader = "⚠ AUDIT LEDGER VERIFICATION: NO EVENTS (EMPTY LEDGER)";
  } else {
    statusHeader = pc.green(pc.bold("✔ AUDIT LEDGER VERIFICATION: PASSED"));
    rawHeader = "✔ AUDIT LEDGER VERIFICATION: PASSED";
  }

  const padRight = Math.max(0, 70 - rawHeader.length);

  const lines = [
    pc.cyan(
      "┌────────────────────────────────────────────────────────────────────────┐",
    ),
    pc.cyan("│ ") + statusHeader + " ".repeat(padRight) + pc.cyan("│"),
    pc.cyan(
      "├────────────────────────────────────────────────────────────────────────┤",
    ),
    pc.cyan("│ ") +
      pc.white(`Verified Events:  `) +
      pc.bold(String(verifiedCount)).padEnd(52) +
      pc.cyan("│"),
    pc.cyan("│ ") +
      pc.white(`Sequence Span:    `) +
      `${fromSeq} → ${toSeq}`.padEnd(52) +
      pc.cyan("│"),
    pc.cyan("│ ") +
      pc.white(`Genesis PrevHash: `) +
      `${GENESIS_PREV_HASH.slice(0, 16)}...${GENESIS_PREV_HASH.slice(-8)}`.padEnd(
        52,
      ) +
      pc.cyan("│"),
    pc.cyan("│ ") +
      pc.white(`Latest Seal Hash: `) +
      `${latestHash.slice(0, 16)}...${latestHash.slice(-8)}`.padEnd(52) +
      pc.cyan("│"),
    pc.cyan("│ ") +
      pc.white(`Checkpoint Anchor:`) +
      ` ${formatCheckpointStatus(checkpointStatus)}`.padEnd(52) +
      pc.cyan("│"),
    pc.cyan("│ ") +
      pc.white(`Elapsed Time:     `) +
      `${elapsedMs} ms`.padEnd(52) +
      pc.cyan("│"),
  ];

  if (!overallValid && failureError) {
    lines.push(
      pc.cyan(
        "├────────────────────────────────────────────────────────────────────────┤",
      ),
    );
    lines.push(
      pc.cyan("│ ") +
        pc.red(pc.bold("FAILURE DETAIL:   ")) +
        "".padEnd(52) +
        pc.cyan("│"),
    );
    lines.push(
      pc.cyan("│ ") +
        pc.red(failureError.slice(0, 70)).padEnd(70) +
        pc.cyan("│"),
    );
    if (failedSeq !== undefined) {
      lines.push(
        pc.cyan("│ ") +
          pc.yellow(`Failed Sequence:  seq ${failedSeq}`).padEnd(70) +
          pc.cyan("│"),
      );
    }
  }

  lines.push(
    pc.cyan(
      "└────────────────────────────────────────────────────────────────────────┘",
    ),
  );
  const formattedOutput = lines.join("\n");

  return {
    valid: overallValid,
    verifiedCount,
    fromSeq,
    toSeq,
    genesisPrevHash: GENESIS_PREV_HASH,
    latestHash,
    checkpoint: {
      status: checkpointStatus,
      seq: checkpointSeq,
      hash: checkpointHash,
      kid: checkpointKid,
      error: checkpointError,
    },
    error: failureError,
    failedSeq,
    elapsedMs,
    formattedOutput,
  };
}

function formatCheckpointStatus(status: CheckpointAnchorStatus): string {
  switch (status) {
    case "VALIDATED":
      return pc.green(pc.bold("VALIDATED (Cryptographically Anchored)"));
    case "NO_CHECKPOINT":
      return pc.yellow("NO_CHECKPOINT (Local Chain Validated)");
    case "MISMATCH":
      return pc.red(pc.bold("MISMATCH (Ledger/Checkpoint Divergence)"));
    case "INVALID_SIGNATURE":
      return pc.red(
        pc.bold("INVALID_SIGNATURE (Signature Forgery/Corruption)"),
      );
    case "UNAUTHORIZED_SIGNER":
      return pc.red(pc.bold("UNAUTHORIZED_SIGNER (Role Violation)"));
    case "UNKNOWN_KEY":
      return pc.red(pc.bold("UNKNOWN_KEY (Key Not In Keyset)"));
  }
}

/**
 * SRE CLI engine: synapse audit checkpoint
 * Signs periodic checkpoint of latest sealed audit chain and anchors to write-once storage.
 */
export async function executeAuditCheckpoint(
  params: AuditCheckpointParams,
): Promise<AuditCheckpointResult> {
  // 1. Query latest sealed sequence and hash
  let seq = 0;
  let hash = GENESIS_PREV_HASH;
  let total = 0;

  if (params.pgPool || params.db) {
    let pool: pg.Pool;
    let isCreated = false;
    if (params.pgPool) {
      pool = params.pgPool;
    } else {
      const connStr = params.db || process.env.DATABASE_URL;
      if (!connStr) {
        throw new Error(
          "No database connection string provided for checkpoint creation",
        );
      }
      pool = new Pool({ connectionString: connStr });
      isCreated = true;
    }

    try {
      const [latestRes, countRes] = await Promise.all([
        pool.query<{ seq: string | number; hash: string; ts: Date | string }>(
          "SELECT seq, hash, ts FROM audit_events ORDER BY seq DESC LIMIT 1",
        ),
        pool.query<{ count: string }>(
          "SELECT COUNT(*)::bigint AS count FROM audit_events",
        ),
      ]);
      total = parseInt(countRes.rows[0]?.count ?? "0", 10);
      if (latestRes.rows.length > 0) {
        seq = Number(latestRes.rows[0]!.seq);
        hash = latestRes.rows[0]!.hash;
      }
    } finally {
      if (isCreated) {
        await pool.end();
      }
    }
  } else {
    const apiUrl =
      params.apiUrl || process.env.SYNAPSE_API_URL || "http://localhost:3000";
    const token = params.token || process.env.SYNAPSE_API_TOKEN;
    const fetchFn = params.fetchFn ?? fetch;

    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetchFn(
      `${apiUrl.replace(/\/$/, "")}/v1/audit/checkpoint/latest`,
      {
        headers,
      },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Failed to fetch latest audit checkpoint from API: ${errText}`,
      );
    }
    const data = (await res.json()) as {
      checkpoint_seq: number;
      checkpoint_hash: string;
      sealed_count: number;
    };
    seq = data.checkpoint_seq;
    hash = data.checkpoint_hash;
    total = data.sealed_count;
  }

  // Invariant 7 (I6): Refuse to sign checkpoint if ledger has no sealed events
  if (seq === 0 && total === 0) {
    throw new Error(
      "Audit ledger is empty (no sealed events); refusing to sign genesis checkpoint. Seal at least one event first.",
    );
  }

  // 2. Resolve kid and key
  const kid =
    params.kid || process.env.CHECKPOINT_SIGNING_KID || "audit-signer";
  const payload: CheckpointPayload = {
    v: 1,
    checkpoint_seq: seq,
    checkpoint_hash: hash,
    timestamp: new Date().toISOString(),
    sealed_count: total,
    kid,
  };

  // 3. Sign checkpoint envelope
  let envelope: CheckpointEnvelope;
  let signerFingerprint: string | undefined;
  const privateKey = params.key || process.env.CHECKPOINT_SIGNING_KEY;

  if (privateKey) {
    // Invariant 2 & I4: Bind kid to private key by deriving public key and verifying against keyset
    const privKey = resolvePrivateKey(privateKey);
    const pubKey = crypto.createPublicKey(privKey);
    signerFingerprint = formatPublicKeyToHex(pubKey);

    const keyset = await loadKeyset(params.keyset);
    if (keyset) {
      const keyEntry = getKey(keyset, kid);
      if (!keyEntry) {
        throw new Error(`Signer key "${kid}" not found in trusted keyset`);
      }
      // O1: Normalize keyset public key (supports hex, base64url, PEM, SPKI-DER) to 64-char hex
      const expectedHex = formatPublicKeyToHex(
        resolvePublicKey(keyEntry.public_key),
      );
      if (expectedHex.toLowerCase() !== signerFingerprint.toLowerCase()) {
        throw new Error(
          `Derived public key fingerprint "${signerFingerprint}" does not match public key "${keyEntry.public_key}" in keyset for kid "${kid}"`,
        );
      }
      if (!canSignCheckpoint(keyEntry)) {
        throw new Error(
          `Key "${kid}" in keyset does not have checkpoint_signer, audit_signer, or admin role`,
        );
      }
    }

    envelope = signCheckpoint(payload, privateKey);
  } else if (
    params.keyFile ||
    params.password ||
    params.passphraseEnv ||
    process.env.SYNAPSE_KEY_PASSWORD
  ) {
    const filePath = params.keyFile
      ? path.resolve(params.keyFile)
      : path.join(process.cwd(), `${kid}.key`);

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

    if (!password) {
      throw new Error(
        "Passphrase required for keyfile: provide --passphrase-env, set SYNAPSE_KEY_PASSWORD, or use --password",
      );
    }
    const signer = await EncryptedKeyfileSigner.load({ filePath, password });
    envelope = await signCheckpointWithSigner(payload, signer);
  } else {
    throw new Error(
      "No checkpoint signing key provided. Set CHECKPOINT_SIGNING_KEY, --key, or configure --key-file.",
    );
  }

  // 4. Save and Anchor Checkpoint Envelope
  const savedTo: string[] = [];
  const envelopeJson = JSON.stringify(envelope, null, 2);

  // Local file destination
  if (params.out) {
    const resolvedPath = path.resolve(params.out);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, envelopeJson, "utf-8");
    savedTo.push(params.out);
  }

  // S3 write-once destination
  const s3Bucket = params.s3Bucket || process.env.S3_BUCKET;
  if (s3Bucket) {
    const s3Region = params.s3Region || process.env.S3_REGION || "us-east-1";
    // O4: Strip leading/trailing slashes and fall back safely if an all-slash string was provided
    const s3Prefix =
      (params.s3Prefix || process.env.S3_PREFIX || "checkpoints").replace(
        /^\/+|\/+$/g,
        "",
      ) || "checkpoints";

    const s3Client = params.s3Client ?? new S3Client({ region: s3Region });

    const seqKey = `${s3Prefix}/${seq}.json`;
    const latestKey = `${s3Prefix}/checkpoint-latest.json`;

    // ADR 0005 & I5: Compute SHA-256 base64 checksum for end-to-end immutability
    const checksumSha256 = crypto
      .createHash("sha256")
      .update(envelopeJson)
      .digest("base64");

    const putSeqCommandInput: {
      Bucket: string;
      Key: string;
      Body: string;
      ContentType: string;
      ChecksumSHA256: string;
      ObjectLockMode?: "COMPLIANCE" | "GOVERNANCE";
      ObjectLockRetainUntilDate?: Date;
    } = {
      Bucket: s3Bucket,
      Key: seqKey,
      Body: envelopeJson,
      ContentType: "application/json",
      ChecksumSHA256: checksumSha256,
    };

    if (params.s3ObjectLock || process.env.S3_OBJECT_LOCK === "true") {
      putSeqCommandInput.ObjectLockMode = "COMPLIANCE";
      putSeqCommandInput.ObjectLockRetainUntilDate = new Date(
        Date.now() + 365 * 24 * 3600 * 1000,
      );
    }

    // ADR 0005 & O2: Latest pointer intentionally not Object-Locked: mutated each checkpoint; immutability lives on <seq>.json
    const putLatestCommandInput = {
      Bucket: s3Bucket,
      Key: latestKey,
      Body: envelopeJson,
      ContentType: "application/json",
      ChecksumSHA256: checksumSha256,
    };

    await Promise.all([
      s3Client.send(new PutObjectCommand(putSeqCommandInput)),
      s3Client.send(new PutObjectCommand(putLatestCommandInput)),
    ]);

    savedTo.push(`s3://${s3Bucket}/${seqKey}`);
    savedTo.push(`s3://${s3Bucket}/${latestKey}`);
  }

  const lines = [
    pc.green(pc.bold("✔ AUDIT CHECKPOINT SIGNED & ANCHORED")),
    pc.white(`Checkpoint Seq:  `) + pc.bold(String(seq)),
    pc.white(`Checkpoint Hash: `) + pc.cyan(hash),
    pc.white(`Timestamp:       `) + payload.timestamp,
    pc.white(`Signer Kid:      `) + kid,
  ];
  if (signerFingerprint) {
    lines.push(
      pc.white(`Signer PubKey:   `) +
        pc.cyan(
          `${signerFingerprint.slice(0, 16)}...${signerFingerprint.slice(-8)}`,
        ),
    );
  }
  lines.push(
    pc.white(`Saved Targets:   `) +
      (savedTo.length > 0 ? savedTo.join(", ") : pc.yellow("(none specified)")),
  );
  const formattedOutput = lines.join("\n");

  return {
    envelope,
    savedTo,
    formattedOutput,
  };
}

/**
 * Registers audit CLI commands with commander.
 */
export function registerAuditCommands(program: Command): void {
  const audit = program
    .command("audit")
    .description(
      "Tamper-evident audit ledger verification and checkpoint anchoring",
    );

  audit
    .command("verify")
    .description(
      "Independently recomputes SHA-256 hash chain from genesis and cross-verifies external checkpoints",
    )
    .option(
      "-f, --file <path>",
      "Path to exported audit events JSON or JSONL file",
    )
    .option("--api-url <url>", "Control API URL (or SYNAPSE_API_URL)")
    .option(
      "-t, --token <token>",
      "Control API authentication Bearer token (or SYNAPSE_API_TOKEN)",
    )
    .option("-d, --db <url>", "PostgreSQL connection string (or DATABASE_URL)")
    .option(
      "-c, --checkpoint <path-or-url>",
      "Path or URL to signed checkpoint envelope",
    )
    .option(
      "-k, --keyset <path>",
      "Path to trusted keyset.json (or KEYSET_PATH)",
    )
    .option("--json", "Emit structured machine-readable JSON output")
    .action(async (opts) => {
      try {
        const result = await executeAuditVerify(opts);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.formattedOutput);
        }
        if (!result.valid) {
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        console.error(
          pc.red(
            `Audit verification failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exitCode = 1;
      }
    });

  audit
    .command("checkpoint")
    .description(
      "Signs periodic checkpoint of latest sealed audit chain and anchors to write-once storage",
    )
    .option("--api-url <url>", "Control API URL (or SYNAPSE_API_URL)")
    .option(
      "-t, --token <token>",
      "Control API authentication Bearer token (or SYNAPSE_API_TOKEN)",
    )
    .option("-d, --db <url>", "PostgreSQL connection string (or DATABASE_URL)")
    .option(
      "-k, --keyset <path>",
      "Path to trusted keyset.json to verify key binding (or KEYSET_PATH)",
    )
    .option("--kid <kid>", "Signer key identifier matching keyset.json")
    .option(
      "--key <private-key>",
      "Ed25519 private key (or CHECKPOINT_SIGNING_KEY)",
    )
    .option("--key-file <path>", "Path to encrypted keyfile")
    .option("--password <password>", "Passphrase for encrypted keyfile")
    .option(
      "--passphrase-env <name>",
      "Environment variable holding passphrase",
    )
    .option(
      "-o, --out <path>",
      "Output path for signed checkpoint envelope JSON",
    )
    .option(
      "--s3-bucket <bucket>",
      "S3 bucket for immutable checkpoint anchoring (or S3_BUCKET)",
    )
    .option(
      "--s3-region <region>",
      "S3 region (or S3_REGION, default us-east-1)",
    )
    .option(
      "--s3-prefix <prefix>",
      "S3 prefix (or S3_PREFIX, default checkpoints)",
    )
    .option(
      "--s3-object-lock",
      "Enable S3 Object Lock in COMPLIANCE mode (or S3_OBJECT_LOCK)",
    )
    .option("--json", "Emit structured machine-readable JSON output")
    .action(async (opts) => {
      try {
        const result = await executeAuditCheckpoint(opts);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.formattedOutput);
        }
      } catch (err: unknown) {
        console.error(
          pc.red(
            `Audit checkpoint creation failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
