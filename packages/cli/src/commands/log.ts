import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import Table from "cli-table3";
import pc from "picocolors";
import YAML from "yaml";
import { LeaseEnvelopeSchema } from "@synapsestate/lease";
import {
  rankSuspects,
  type ChangeEvent,
  type FlagEvaluationRecord,
  type RankedSuspect,
} from "../ranker.js";

const execFileAsync = promisify(execFile);

export interface LogParams {
  service?: string;
  env?: string;
  since?: string;
  flag?: string;
  limit?: number;
  offline?: boolean;
  offlineDir?: string;
  offlineDirs?: string[];
  offlineGitCwd?: string;
  gitRunner?: (args: string[], cwd?: string) => Promise<string>;
  json?: boolean;
  apiUrl?: string;
  fetchFn?: typeof fetch;
  nowMs?: number;
}

export interface LogResult {
  query: {
    env: string;
    since: string;
    service?: string;
    flag_key?: string;
    limit: number;
    offline?: boolean;
  };
  suspects: RankedSuspect[];
  events: ChangeEvent[];
  evaluations: FlagEvaluationRecord[];
  formattedOutput: string;
  warning?: string;
}

/**
 * Parses a relative duration string (e.g. "30s", "15m", "2h", "1d") or an ISO timestamp into a Date.
 */
export function parseSince(sinceStr: string, now: Date = new Date()): Date {
  const trimmed = sinceStr.trim();
  const relMatch = /^(\d+)([smhd])$/i.exec(trimmed);
  if (relMatch) {
    const val = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    let ms = 0;
    if (unit === "s") ms = val * 1000;
    else if (unit === "m") ms = val * 60 * 1000;
    else if (unit === "h") ms = val * 3600 * 1000;
    else if (unit === "d") ms = val * 86400 * 1000;

    const targetTime = now.getTime() - ms;
    if (!Number.isFinite(targetTime) || targetTime < 0) {
      throw new Error(
        `Duration or timestamp '${sinceStr}' results in an out-of-range date`,
      );
    }
    return new Date(targetTime);
  }

  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime()) && Number.isFinite(parsed.getTime())) {
    return parsed;
  }

  throw new Error(
    `Invalid duration or timestamp format for 'since': "${sinceStr}"`,
  );
}

/**
 * Formats a timestamp into a human-friendly relative duration (e.g. "2m ago", "45s ago").
 */
function formatRelativeTime(dateStr: string, nowMs: number): string {
  const time = new Date(dateStr).getTime();
  if (!Number.isFinite(time)) return "unknown";

  const diffMs = Math.max(0, nowMs - time);
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
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
 * Default git runner executing git via execFile.
 */
async function defaultGitRunner(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: cwd ?? process.cwd(),
  });
  return stdout;
}

/**
 * Inspects local git repository commits for modified flag definitions in flags/<env>/.
 */
async function inspectLocalGitCommits(
  env: string,
  sinceDate: Date,
  limit: number,
  cwd?: string,
  gitRunner: (
    args: string[],
    cwd?: string,
  ) => Promise<string> = defaultGitRunner,
): Promise<ChangeEvent[]> {
  const sinceIso = sinceDate.toISOString();
  const flagPath = `flags/${env}/`;
  const events: ChangeEvent[] = [];

  try {
    const rawOutput = await gitRunner(
      [
        "log",
        `-n`,
        String(limit),
        `--since=${sinceIso}`,
        "--name-only",
        "--format=%H%x09%an%x09%aI%x09%s",
        "--",
        flagPath,
      ],
      cwd,
    );

    const lines = rawOutput.split(/\r?\n/);
    let currentCommit: {
      hash: string;
      author: string;
      date: string;
      subject: string;
    } | null = null;
    // Use negative IDs for synthetic git events to prevent collision with database IDs
    let syntheticId = -1000;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.includes("\t")) {
        // New commit header
        const parts = line.split("\t");
        if (parts.length >= 4) {
          currentCommit = {
            hash: parts[0],
            author: parts[1],
            date: parts[2],
            subject: parts.slice(3).join("\t"),
          };
        }
      } else if (currentCommit && line.startsWith(flagPath)) {
        // Strict lowercase matching per ADR 0007 charset
        const fileSubPath = line.slice(flagPath.length);
        const match = /^([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\.yaml$/.exec(
          fileSubPath,
        );
        if (match) {
          const flagKey = match[1];

          // Attempt to load local flag schema to infer defaultVariant if available (B2)
          let payloadValue: unknown = undefined;
          try {
            const yamlPath = path.join(
              cwd ?? process.cwd(),
              flagPath,
              `${flagKey}.yaml`,
            );
            const yamlContent = await fs.readFile(yamlPath, "utf8");
            const parsedYaml = YAML.parse(yamlContent);
            if (
              parsedYaml &&
              typeof parsedYaml === "object" &&
              parsedYaml.defaultVariant !== undefined
            ) {
              payloadValue = parsedYaml.defaultVariant;
            }
          } catch {
            // Local file might not exist in checkout or unreadable
          }

          events.push({
            id: syntheticId--,
            event_type: "GIT_MERGE",
            env,
            flag_key: flagKey,
            actor: currentCommit.author,
            occurred_at: currentCommit.date,
            payload: {
              commit_sha: currentCommit.hash,
              message: currentCommit.subject,
              ...(payloadValue !== undefined ? { value: payloadValue } : {}),
            },
          });
        }
      }
    }
  } catch {
    // If git fails or repository doesn't exist, return empty array gracefully
  }

  return events;
}

/**
 * Inspects local emergency lease files from configured emergency lease directories.
 */
async function inspectLocalEmergencyLeases(
  env: string,
  sinceDate: Date,
  dirs: string[],
): Promise<ChangeEvent[]> {
  const events: ChangeEvent[] = [];
  // Use negative IDs for synthetic emergency lease events
  let syntheticId = -5000;

  for (const dir of dirs) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const filePath = path.join(dir, file);
          const raw = await fs.readFile(filePath, "utf8");
          const parsed = JSON.parse(raw);
          const validated = LeaseEnvelopeSchema.safeParse(parsed);
          if (validated.success) {
            const envelope = validated.data;
            if (envelope.payload.env !== env) continue;

            const occurredDate = new Date(envelope.payload.issued_at);
            if (occurredDate < sinceDate) continue;

            events.push({
              id: syntheticId--,
              event_type: "LEASE_CREATED",
              env: envelope.payload.env,
              flag_key: envelope.payload.flag_key,
              actor: envelope.payload.kid,
              occurred_at: occurredDate.toISOString(),
              payload: {
                lease_id: envelope.payload.lease_id,
                value: envelope.payload.value,
                reason: envelope.payload.reason,
                ttl_seconds: envelope.payload.ttl_seconds,
                offline: true,
                unverified: true,
              },
            });
          }
        } catch {
          // Ignore unreadable or malformed files
        }
      }
    } catch {
      // Directory not accessible
    }
  }

  return events;
}

/**
 * Executes the `synapse log` incident investigation command.
 */
export async function executeLog(params: LogParams): Promise<LogResult> {
  const env = params.env ?? process.env.SYNAPSE_ENV ?? "production";
  const sinceStr = params.since ?? "30m";
  const service = params.service;
  const flagFilter = params.flag;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const nowMs = params.nowMs ?? Date.now();
  const now = new Date(nowMs);

  const sinceDate = parseSince(sinceStr, now);

  let events: ChangeEvent[] = [];
  let evaluations: FlagEvaluationRecord[] = [];
  let warning: string | undefined;

  if (params.offline) {
    warning =
      "[OFFLINE MODE] Control API offline or --offline flag specified. Telemetry volume weighting unavailable; ranking based strictly on Git commits and local emergency leases (unverified local state).";

    const leaseDirs: string[] = params.offlineDirs ?? [
      ...(params.offlineDir ? [params.offlineDir] : []),
      ...(process.env.SYNAPSE_EMERGENCY_LEASES_DIR
        ? [process.env.SYNAPSE_EMERGENCY_LEASES_DIR]
        : []),
      path.join(os.homedir(), ".synapse", "emergency-leases"),
      "/etc/synapse/emergency-leases",
    ];

    const [gitEvents, leaseEvents] = await Promise.all([
      inspectLocalGitCommits(
        env,
        sinceDate,
        limit,
        params.offlineGitCwd,
        params.gitRunner,
      ),
      inspectLocalEmergencyLeases(env, sinceDate, leaseDirs),
    ]);

    events = [...leaseEvents, ...gitEvents];
    evaluations = [];
  } else {
    const apiUrl = (
      params.apiUrl ??
      process.env.SYNAPSE_API_URL ??
      "http://localhost:3000"
    ).replace(/\/$/, "");

    const fetchFn = params.fetchFn ?? fetch;

    const queryParams = new URLSearchParams({
      env,
      since: sinceStr,
      limit: String(limit),
    });
    if (service) queryParams.set("service", service);
    if (flagFilter) queryParams.set("flag_key", flagFilter);

    const url = `${apiUrl}/v1/changes?${queryParams.toString()}`;

    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Control API unreachable at ${apiUrl} (${msg}). If the control plane is offline during an incident, rerun with --offline to inspect local Git and emergency leases.`,
      );
    }

    if (!res.ok) {
      let serverError = "";
      try {
        const body = (await res.json()) as { error?: string };
        serverError = body.error ? `: ${body.error}` : "";
      } catch {
        serverError = `: ${res.statusText}`;
      }
      const offlineHint =
        res.status >= 500
          ? " If the control plane is degraded, rerun with --offline to inspect local Git and emergency leases."
          : "";
      throw new Error(
        `Failed to fetch change history from Control API (${res.status})${serverError}.${offlineHint}`,
      );
    }

    const data = (await res.json()) as {
      events?: ChangeEvent[];
      evaluations?: FlagEvaluationRecord[];
    };
    events = data.events ?? [];
    evaluations = data.evaluations ?? [];
  }

  // Apply optional flag filtering on events
  if (flagFilter) {
    events = events.filter((e) => e.flag_key === flagFilter);
  }

  // Sort events by occurred_at DESC with NaN safety, limit
  events.sort((a, b) => {
    const tA = new Date(a.occurred_at).getTime();
    const tB = new Date(b.occurred_at).getTime();
    return (Number.isFinite(tB) ? tB : 0) - (Number.isFinite(tA) ? tA : 0);
  });
  events = events.slice(0, limit);

  // Pure attribution ranking
  const suspects = rankSuspects(events, evaluations, service ?? "", nowMs);

  let formattedOutput = "";

  if (params.json) {
    formattedOutput = JSON.stringify(
      {
        query: {
          env,
          since: sinceStr,
          ...(service ? { service } : {}),
          ...(flagFilter ? { flag_key: flagFilter } : {}),
          limit,
          offline: Boolean(params.offline),
        },
        suspects,
        events,
        evaluations,
      },
      null,
      2,
    );
  } else {
    const lines: string[] = [];

    if (warning) {
      lines.push(pc.yellow(warning));
      lines.push("");
    }

    lines.push(pc.bold(pc.cyan("SynapseState Incident Attribution Log")));
    lines.push(
      pc.dim(
        `Environment: ${env} | Service: ${service || "all"} | Window: ${sinceStr} | Events: ${events.length}`,
      ),
    );
    lines.push("");

    if (suspects.length === 0) {
      lines.push(
        pc.dim(
          `No feature flag changes found for environment "${env}" within window "${sinceStr}".`,
        ),
      );
    } else {
      const table = new Table({
        head: [
          pc.bold("Rank"),
          pc.bold("Score"),
          pc.bold("Flag Key"),
          pc.bold("Event"),
          pc.bold("Occurred"),
          pc.bold("Actor"),
          pc.bold("Evals"),
          pc.bold("Suggested Value"),
        ],
        style: { head: [], border: [] },
      });

      for (let i = 0; i < suspects.length; i++) {
        const s = suspects[i];
        const rankStr = `#${i + 1}`;

        let scoreStr = String(s.score);
        if (s.score >= 75) {
          scoreStr = pc.red(pc.bold(scoreStr));
        } else if (s.score >= 40) {
          scoreStr = pc.yellow(scoreStr);
        } else {
          scoreStr = pc.dim(scoreStr);
        }

        let eventStr = s.event_type;
        if (s.event_type === "LEASE_CREATED") {
          eventStr = pc.green(eventStr);
        } else if (s.event_type === "GIT_MERGE") {
          eventStr = pc.cyan(eventStr);
        } else if (s.event_type === "LEASE_REVOKED") {
          eventStr = pc.yellow(eventStr);
        } else {
          eventStr = pc.dim(eventStr);
        }

        const occurredStr = formatRelativeTime(s.occurred_at, nowMs);
        const evalCountStr =
          s.eval_count > 0 ? s.eval_count.toLocaleString() : pc.dim("0");
        const suggestedValStr = pc.bold(
          String(s.suggested_action.suggested_value),
        );

        table.push([
          rankStr,
          scoreStr,
          pc.cyan(s.flag_key),
          eventStr,
          occurredStr,
          s.actor,
          evalCountStr,
          suggestedValStr,
        ]);
      }

      lines.push(table.toString());
      lines.push("");

      // Top Suspect Mitigations (Ready-to-run)
      lines.push(
        pc.bold(pc.underline("Top Suspect Mitigations (Ready-to-run):")),
      );
      const topCount = Math.min(suspects.length, 3);
      for (let i = 0; i < topCount; i++) {
        const s = suspects[i];
        lines.push(
          `${pc.bold(`#${i + 1} ${s.flag_key}`)} ${pc.dim(`(Score: ${s.score}, Reason: ${s.suggested_action.reason})`)}`,
        );
        lines.push(`  ${pc.green(s.suggested_action.command)}`);
      }
    }

    formattedOutput = lines.join("\n");
  }

  return {
    query: {
      env,
      since: sinceStr,
      ...(service ? { service } : {}),
      ...(flagFilter ? { flag_key: flagFilter } : {}),
      limit,
      offline: Boolean(params.offline),
    },
    suspects,
    events,
    evaluations,
    formattedOutput,
    warning,
  };
}

/**
 * Registers `synapse log` command on Commander program.
 */
export function registerLogCommands(program: Command): void {
  program
    .command("log")
    .description(
      "Investigate recent feature flag changes and rank incident suspect flags",
    )
    .option(
      "-s, --service <name>",
      "Target service experiencing degradation (e.g. checkout-service)",
    )
    .option(
      "-e, --env <env>",
      "Target environment (default: production or SYNAPSE_ENV)",
      "production",
    )
    .option(
      "--since <duration>",
      "Duration window (e.g. 15m, 30m, 2h, 1d; default: 30m)",
      "30m",
    )
    .option("-f, --flag <key>", "Feature flag key filter (e.g. checkout-v2)")
    .option(
      "-l, --limit <num>",
      "Maximum events to inspect (default: 50, max: 200)",
      (v) => parseIntegerOption(v, "--limit", 1, 200),
      50,
    )
    .option(
      "--offline",
      "Air-gapped fallback mode inspecting local Git commits and emergency lease files",
      false,
    )
    .option(
      "--offline-dir <dir>",
      "Directory for offline emergency leases (default: /etc/synapse/emergency-leases)",
    )
    .option("--json", "Emit machine-readable JSON", false)
    .option(
      "--api-url <url>",
      "Control API base URL (default: http://localhost:3000 or SYNAPSE_API_URL)",
    )
    .action(async (opts) => {
      try {
        const res = await executeLog({
          service: opts.service,
          env: opts.env,
          since: opts.since,
          flag: opts.flag,
          limit: opts.limit,
          offline: opts.offline,
          offlineDir: opts.offlineDir,
          json: opts.json,
          apiUrl: opts.apiUrl,
        });
        console.log(res.formattedOutput);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`Error: ${message}`));
        process.exitCode = 1;
      }
    });
}
