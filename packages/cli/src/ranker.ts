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
const RECENCY_HALF_LIFE_MS = 15 * 60 * 1000; // 15 minutes tau decay

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
  let suggestedValue: boolean | number | string = false;
  let reason = `Mitigate suspect flag for ${targetService || "service"}`;

  if (rawVal !== undefined && rawVal !== null) {
    if (rawVal === true || rawVal === "true") {
      suggestedValue = false;
      reason = "Revert active true override to safe baseline false";
    } else if (rawVal === false || rawVal === "false") {
      suggestedValue = true;
      reason = "Revert false override to enabled state true";
    } else if (typeof rawVal === "string" && rawVal.toLowerCase() === "on") {
      suggestedValue = "off";
      reason = "Revert 'on' override to safe variant 'off'";
    } else if (typeof rawVal === "string" && rawVal.toLowerCase() === "off") {
      suggestedValue = "on";
      reason = "Revert 'off' override to active variant 'on'";
    } else if (typeof rawVal === "string" && rawVal.toLowerCase() === "enabled") {
      suggestedValue = "disabled";
      reason = "Revert enabled override to safe baseline disabled";
    } else if (typeof rawVal === "string" && rawVal.toLowerCase() === "disabled") {
      suggestedValue = "enabled";
      reason = "Revert disabled override to active variant enabled";
    } else if (typeof rawVal === "number") {
      suggestedValue = rawVal === 1 ? 0 : rawVal === 0 ? 1 : 0;
      reason = `Revert numeric value ${rawVal} to baseline numeric ${suggestedValue}`;
    } else if (typeof rawVal === "string") {
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
      } else if (currentVariant === "true") {
        suggestedValue = false;
      } else if (currentVariant === "on") {
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
 * - Groups change events by flag_key and picks latest event per flag.
 * - Applies exponential recency decay (tau = 15m).
 * - Weights by correlated evaluation volume from targetService.
 * - Weights by event type severity (LEASE_CREATED / GIT_MERGE > LEASE_EXPIRED).
 * - Derives type-aware ready-to-run mitigation overrides.
 * - Tie-breaks deterministically by score DESC, occurred_at DESC, flag_key ASC.
 */
export function rankSuspects(
  events: ChangeEvent[],
  evaluations: FlagEvaluationRecord[],
  targetService: string,
  nowMs: number = Date.now(),
): RankedSuspect[] {
  // Filter valid events with non-empty flag_key
  const validEvents = events.filter(
    (e) => typeof e.flag_key === "string" && e.flag_key.trim().length > 0,
  );

  if (validEvents.length === 0) {
    return [];
  }

  // Pre-calculate evaluation counts by flag_key
  const evalsByFlag = new Map<string, FlagEvaluationRecord[]>();
  const totalVolumeByFlag = new Map<string, number>();
  let maxVolume = 0;

  for (const record of evaluations) {
    if (!evalsByFlag.has(record.flag_key)) {
      evalsByFlag.set(record.flag_key, []);
    }
    evalsByFlag.get(record.flag_key)!.push(record);

    const currentTotal = (totalVolumeByFlag.get(record.flag_key) ?? 0) + record.eval_count;
    totalVolumeByFlag.set(record.flag_key, currentTotal);
  }

  for (const vol of totalVolumeByFlag.values()) {
    if (vol > maxVolume) {
      maxVolume = vol;
    }
  }

  // Group events by flag_key
  const eventsByFlag = new Map<string, ChangeEvent[]>();
  for (const event of validEvents) {
    const key = event.flag_key!;
    if (!eventsByFlag.has(key)) {
      eventsByFlag.set(key, []);
    }
    eventsByFlag.get(key)!.push(event);
  }

  const suspects: RankedSuspect[] = [];

  for (const [flagKey, flagEvents] of eventsByFlag.entries()) {
    // Sort events for this flag by occurred_at DESC, id DESC
    flagEvents.sort((a, b) => {
      const diff = new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
      if (diff !== 0) return diff;
      return b.id - a.id;
    });

    const latestEvent = flagEvents[0];
    const occurredAtMs = new Date(latestEvent.occurred_at).getTime();
    const deltaMs = Math.max(0, nowMs - occurredAtMs);

    // 1. Recency Decay Score (tau = 15m)
    const decay = Math.exp(-deltaMs / RECENCY_HALF_LIFE_MS);
    const recencyScore = Math.round(decay * 100);

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

    const envArg = latestEvent.env || "production";
    const command = `synapse lease create --flag ${flagKey} --env ${envArg} --value ${suggestedValue} --ttl 30m --reason "Incident mitigation for ${targetService || "service"}"`;

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

  // Deterministic sorting: score DESC, occurred_at DESC, flag_key ASC
  suspects.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const timeDiff = new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return a.flag_key.localeCompare(b.flag_key);
  });

  return suspects;
}
