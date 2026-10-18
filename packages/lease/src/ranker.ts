import { FLAG_KEY_REGEX } from "./schema.js";

export interface ChangeEvent {
  id: number;
  event_type:
    | "LEASE_CREATED"
    | "LEASE_REVOKED"
    | "LEASE_SUPERSEDED"
    | "LEASE_EXPIRED"
    | "LEASE_PROMOTED"
    | "GIT_MERGE"
    | string;
  env: string;
  flag_key: string | null;
  actor: string;
  occurred_at: string; // ISO-8601
  payload: Record<string, unknown>;
}

export interface FlagEvaluationRecord {
  flag_key: string;
  variant: string;
  eval_count: number;
}

export interface SuggestedAction {
  command: string; // ready-to-run: synapse lease create --flag ...
  suggested_value: boolean | number | string;
  reason: string;
}

export interface RankedSuspect {
  flag_key: string;
  score: number; // 0 to 100 normalized suspect confidence score
  recency_score: number;
  volume_score: number;
  event_type: string;
  occurred_at: string;
  actor: string;
  eval_count: number;
  current_variant?: string;
  suggested_action: SuggestedAction;
}

const EVENT_WEIGHTS: Record<string, number> = {
  LEASE_CREATED: 1.0,
  GIT_MERGE: 1.0,
  LEASE_SUPERSEDED: 0.9,
  LEASE_PROMOTED: 0.8,
  LEASE_REVOKED: 0.6,
  LEASE_EXPIRED: 0.3,
};

const DEFAULT_EVENT_WEIGHT = 0.5;
// Exponential decay time constant tau = 15 minutes (exp(-delta / tau))
const RECENCY_TAU_MS = 15 * 60 * 1000;

/**
 * Safely shell-quotes a command line argument string for POSIX and shell copy-paste safety.
 */
export function quoteShellArg(val: string): string {
  if (/^[a-zA-Z0-9_.-]+$/.test(val)) {
    return val;
  }
  return `'${val.replace(/'/g, "'\\''")}'`;
}

export interface BuildRemediationCommandOptions {
  flagKey: string;
  env: string;
  value: string | number | boolean;
  ttl?: string | number;
  reason: string;
}

/**
 * Centrally constructs an incident remediation CLI command with strict POSIX shell quoting
 * across all arguments (--flag, --env, --value, --ttl, --reason) to prevent shell injection (C1, I7).
 */
export function buildRemediationCommand(options: BuildRemediationCommandOptions): string {
  const flagArg = quoteShellArg(options.flagKey);
  const envArg = quoteShellArg(options.env || "production");
  const valueArg =
    typeof options.value === "string"
      ? quoteShellArg(options.value)
      : String(options.value);
  const ttlString =
    options.ttl !== undefined ? String(options.ttl) : "30m";
  const ttlArg = quoteShellArg(ttlString);
  const reasonArg = quoteShellArg(options.reason);

  return `synapse lease create --flag ${flagArg} --env ${envArg} --value ${valueArg} --ttl ${ttlArg} --reason ${reasonArg}`;
}

/**
 * Derives type-aware suggested mitigation value and reason based on previous value or telemetry history.
 */
function deriveSuggestedAction(
  flagKey: string,
  env: string,
  targetService: string,
  rawVal: unknown,
  flagEvals: FlagEvaluationRecord[],
): { currentVariant?: string; suggestedValue: boolean | number | string; reason: string } {
  let currentVariant: string | undefined = rawVal !== undefined ? String(rawVal) : undefined;
  let suggestedValue: boolean | number | string = "<TYPE>";
  let reason = `Flag type unknown; inspect flags/${env}/${flagKey}.yaml before applying override`;

  if (rawVal !== undefined && rawVal !== null) {
    if (typeof rawVal === "boolean") {
      suggestedValue = !rawVal;
      reason = rawVal
        ? "Revert active true override to safe baseline false"
        : "Revert false override to enabled state true";
    } else if (typeof rawVal === "string") {
      const lower = rawVal.trim().toLowerCase();
      if (lower === "true") {
        suggestedValue = false;
        reason = "Revert active true override to safe baseline false";
      } else if (lower === "false") {
        suggestedValue = true;
        reason = "Revert false override to enabled state true";
      } else if (lower === "on") {
        suggestedValue = "off";
        reason = "Revert 'on' override to safe variant 'off'";
      } else if (lower === "off") {
        suggestedValue = "on";
        reason = "Revert 'off' override to active variant 'on'";
      } else if (lower === "enabled") {
        suggestedValue = "disabled";
        reason = "Revert enabled override to safe baseline disabled";
      } else if (lower === "disabled") {
        suggestedValue = "enabled";
        reason = "Revert disabled override to active variant enabled";
      } else {
        // Multi-variant string (e.g. "canary", "v2", "control")
        const altEvals = flagEvals.filter((e) => e.variant !== rawVal);
        if (altEvals.length > 0) {
          const preferred = altEvals.find((e) =>
            ["control", "baseline", "default", "off"].includes(e.variant.toLowerCase()),
          );
          if (preferred) {
            suggestedValue = preferred.variant;
          } else {
            altEvals.sort((a, b) => b.eval_count - a.eval_count);
            suggestedValue = altEvals[0].variant;
          }
          reason = `Revert variant '${rawVal}' to historical baseline variant '${suggestedValue}'`;
        } else {
          suggestedValue = "control";
          reason = `Revert variant '${rawVal}' to control baseline`;
        }
      }
    } else if (typeof rawVal === "number") {
      suggestedValue = rawVal === 1 ? 0 : rawVal === 0 ? 1 : 0;
      reason = `Revert numeric value ${rawVal} to baseline numeric ${suggestedValue}`;
    }
  } else if (flagEvals.length > 0) {
    // Check evaluations if no explicit value in payload
    const canaryRecord = flagEvals.find((e) =>
      ["canary", "experiment", "v2", "beta"].some((s) => e.variant.toLowerCase().includes(s)),
    );
    const controlRecord = flagEvals.find((e) =>
      ["control", "baseline", "default", "off", "false", "v1"].includes(e.variant.toLowerCase()),
    );

    if (canaryRecord && controlRecord) {
      currentVariant = canaryRecord.variant;
      suggestedValue = controlRecord.variant;
      reason = `Revert '${canaryRecord.variant}' to historical baseline '${controlRecord.variant}'`;
    } else {
      const sorted = [...flagEvals].sort((a, b) => b.eval_count - a.eval_count);
      currentVariant = sorted[0].variant;
      if (sorted.length > 1) {
        suggestedValue = sorted[1].variant;
      } else if (currentVariant.toLowerCase() === "true") {
        suggestedValue = false;
      } else if (currentVariant.toLowerCase() === "on") {
        suggestedValue = "off";
      } else {
        suggestedValue = "control";
      }
      reason = `Mitigate suspect flag using baseline variant '${suggestedValue}'`;
    }
  }

  return { currentVariant, suggestedValue, reason };
}

/**
 * Pure, deterministic incident attribution ranker.
 *
 * Implements ARCHITECTURE §11.4 & ADR 0007:
 * - Validates flag_key charset against FLAG_KEY_REGEX (^[a-z0-9]([-a-z0-9]*[a-z0-9])?$).
 * - Groups change events by flag_key and picks latest event per flag.
 * - Handles malformed dates gracefully without NaN poisoning.
 * - Applies exponential recency decay (tau = 15m).
 * - Weights by correlated evaluation volume from targetService (pre-filtered by Control API).
 * - Scopes maxVolume calculation to candidate suspect flags to prevent dilution by idle flags.
 * - Weights by event type severity (LEASE_CREATED / GIT_MERGE > LEASE_EXPIRED).
 * - Derives type-aware ready-to-run mitigation overrides with safe shell quoting.
 * - Tie-breaks deterministically by score DESC, occurred_at DESC, and codepoint flag_key ASC.
 *
 * NOTE: For reproducible test executions, pass an explicit nowMs timestamp.
 */
export function rankSuspects(
  events: ChangeEvent[],
  evaluations: FlagEvaluationRecord[],
  targetService: string,
  nowMs: number = Date.now(),
): RankedSuspect[] {
  // Filter valid events with compliant flag_key matching FLAG_KEY_REGEX
  const validEvents = events.filter(
    (e) =>
      typeof e.flag_key === "string" &&
      e.flag_key.trim().length > 0 &&
      FLAG_KEY_REGEX.test(e.flag_key.trim()),
  );

  if (validEvents.length === 0) {
    return [];
  }

  // Pre-calculate evaluation counts by flag_key, clamping negative counts
  const evalsByFlag = new Map<string, FlagEvaluationRecord[]>();
  const totalVolumeByFlag = new Map<string, number>();

  for (const record of evaluations) {
    if (!evalsByFlag.has(record.flag_key)) {
      evalsByFlag.set(record.flag_key, []);
    }
    const safeCount = Math.max(0, record.eval_count);
    evalsByFlag.get(record.flag_key)!.push({ ...record, eval_count: safeCount });

    const currentTotal = (totalVolumeByFlag.get(record.flag_key) ?? 0) + safeCount;
    totalVolumeByFlag.set(record.flag_key, currentTotal);
  }

  // Group events by flag_key
  const eventsByFlag = new Map<string, ChangeEvent[]>();
  for (const event of validEvents) {
    const key = event.flag_key!.trim();
    if (!eventsByFlag.has(key)) {
      eventsByFlag.set(key, []);
    }
    eventsByFlag.get(key)!.push(event);
  }

  // Scope maxVolume to suspect flags present in eventsByFlag to prevent dilution
  let maxVolume = 0;
  for (const flagKey of eventsByFlag.keys()) {
    const vol = totalVolumeByFlag.get(flagKey) ?? 0;
    if (vol > maxVolume) {
      maxVolume = vol;
    }
  }

  const suspects: RankedSuspect[] = [];

  for (const [flagKey, flagEvents] of eventsByFlag.entries()) {
    // Sort events for this flag by occurred_at DESC, id DESC with NaN-safe comparator
    flagEvents.sort((a, b) => {
      const tA = new Date(a.occurred_at).getTime();
      const tB = new Date(b.occurred_at).getTime();
      const diff = (Number.isFinite(tB) ? tB : 0) - (Number.isFinite(tA) ? tA : 0);
      if (diff !== 0) return diff;
      return b.id - a.id;
    });

    const latestEvent = flagEvents[0];
    const occurredAtMs = new Date(latestEvent.occurred_at).getTime();
    const isValidDate = Number.isFinite(occurredAtMs);
    const deltaMs = isValidDate ? Math.max(0, nowMs - occurredAtMs) : Infinity;

    // 1. Recency Decay Score (tau = 15m)
    const decay = isValidDate ? Math.exp(-deltaMs / RECENCY_TAU_MS) : 0;
    const recencyScore = isValidDate ? Math.round(decay * 100) : 0;

    // 2. Volume Score
    const flagVolume = totalVolumeByFlag.get(flagKey) ?? 0;
    const volumeRatio = maxVolume > 0 ? flagVolume / maxVolume : 0;
    const volumeScore = maxVolume > 0 ? Math.round(volumeRatio * 100) : 0;

    // 3. Event Type Weight
    const eventWeight = EVENT_WEIGHTS[latestEvent.event_type] ?? DEFAULT_EVENT_WEIGHT;

    // 4. Composite Score
    let rawScore: number;
    if (maxVolume > 0) {
      // Online with telemetry: 50% recency, 35% volume, 15% event weight
      rawScore = (decay * 0.5 + volumeRatio * 0.35 + eventWeight * 0.15) * 100;
    } else {
      // Offline or zero telemetry: 70% recency, 30% event weight
      rawScore = (decay * 0.7 + eventWeight * 0.3) * 100;
    }

    const score = Math.min(100, Math.max(0, Math.round(rawScore)));

    // Derive raw value from latestEvent or any event in history of this flag
    let rawVal: unknown = latestEvent.payload?.value ?? latestEvent.payload?.variant;
    if (rawVal === undefined) {
      for (const ev of flagEvents) {
        if (ev.payload?.value !== undefined || ev.payload?.variant !== undefined) {
          rawVal = ev.payload?.value ?? ev.payload?.variant;
          break;
        }
      }
    }

    const flagEvals = evalsByFlag.get(flagKey) ?? [];
    const { currentVariant, suggestedValue, reason } = deriveSuggestedAction(
      flagKey,
      latestEvent.env,
      targetService,
      rawVal,
      flagEvals,
    );

    // Shell safety: sanitize service and quote command arguments
    const safeService = targetService.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const safeReason = `Incident mitigation for ${safeService || "service"}`;
    const envArg = latestEvent.env || "production";
    const command = buildRemediationCommand({
      flagKey,
      env: envArg,
      value: suggestedValue,
      ttl: "30m",
      reason: safeReason,
    });

    suspects.push({
      flag_key: flagKey,
      score,
      recency_score: recencyScore,
      volume_score: volumeScore,
      event_type: latestEvent.event_type,
      occurred_at: latestEvent.occurred_at,
      actor: latestEvent.actor,
      eval_count: flagVolume,
      current_variant: currentVariant,
      suggested_action: {
        command,
        suggested_value: suggestedValue,
        reason,
      },
    });
  }

  // Deterministic sorting: score DESC, occurred_at DESC, flag_key codepoint ASC
  suspects.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const tA = new Date(a.occurred_at).getTime();
    const tB = new Date(b.occurred_at).getTime();
    const timeDiff = (Number.isFinite(tB) ? tB : 0) - (Number.isFinite(tA) ? tA : 0);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return a.flag_key < b.flag_key ? -1 : a.flag_key > b.flag_key ? 1 : 0;
  });

  return suspects;
}
