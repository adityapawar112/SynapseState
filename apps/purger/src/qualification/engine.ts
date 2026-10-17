/**
 * Pure Qualification Engine for SynapseState Purger.
 *
 * Implements deterministic candidate qualification rules without any network
 * or database I/O, upholding Invariant 6 (Read-Only Codebase Scanner) and
 * the authoritative qualification rule matrix in docs/ARCHITECTURE.md §9.1.
 */

import type {
  CandidateFlag,
  DisqualificationReason,
  FlagTelemetrySnapshot,
  QualificationOptions,
  QualificationResult,
} from "./types.js";

export const DEFAULT_MIN_WINDOW_DAYS = 35;
export const DEFAULT_MAX_WINDOW_DAYS = 45;

/**
 * Evaluates a single flag's telemetry snapshot against the quiescence rule matrix:
 * 1. Lifecycle Class: class === 'release' (killswitch and permanent flags excluded).
 * 2. Invariance Window: served a single variant continuously for >= minWindowDays (or 0 evaluations).
 * 3. Consumer Coverage: 100% of evaluating consumer services have status IN ('ACTIVE', 'RETIRED').
 *    Any service with status 'SILENT' blocks qualification and is recorded in blockingServices.
 * 4. Lease Quiescence: zero active emergency leases.
 */
export function evaluateCandidateQuiescence(
  snapshot: FlagTelemetrySnapshot,
  options?: QualificationOptions,
): QualificationResult {
  const reasons: DisqualificationReason[] = [];
  const minWindowDays = options?.minWindowDays ?? DEFAULT_MIN_WINDOW_DAYS;

  // 1. Lifecycle Class Check
  if (!snapshot.flagClass) {
    reasons.push("UNREGISTERED_FLAG");
  } else if (snapshot.flagClass !== "release") {
    reasons.push("EXCLUDED_LIFECYCLE_CLASS");
  }

  // 2. Active Emergency Lease Check
  if (snapshot.hasActiveLease) {
    reasons.push("ACTIVE_LEASE_EXISTS");
  }

  // 3. Consumer Service Coverage Check
  const silentServices: string[] = [];
  for (const svc of snapshot.services) {
    if (svc.status === "SILENT") {
      silentServices.push(svc.serviceName);
    }
  }

  const uniqueSilentServices = Array.from(new Set(silentServices)).sort();
  if (uniqueSilentServices.length > 0) {
    reasons.push("BLOCKED_BY_SILENT_SERVICE");
  }

  // 4. Observation Window Check
  if (snapshot.windowDays < minWindowDays) {
    reasons.push("INSUFFICIENT_WINDOW");
  }

  // 5. Variant Evaluation & Invariance Check
  const activeVariants = snapshot.variants.filter(
    (v) => Number(v.evalCount) > 0,
  );
  const totalEvaluations = snapshot.variants.reduce(
    (sum, v) => sum + Number(v.evalCount),
    0,
  );

  if (activeVariants.length > 1) {
    reasons.push("MULTI_VARIANT_ACTIVE");
  }

  // If disqualified, return early with reasons and any blocking services
  if (reasons.length > 0) {
    return {
      flagKey: snapshot.flagKey,
      env: snapshot.env,
      status: "DISQUALIFIED",
      reasons,
      ...(uniqueSilentServices.length > 0
        ? { blockingServices: uniqueSilentServices }
        : {}),
    };
  }

  // 6. Winning Variant Determination
  let winningVariant = snapshot.defaultVariant ?? "off";
  if (activeVariants.length === 1) {
    winningVariant = activeVariants[0].variant;
  }

  const evaluatingServices = Array.from(
    new Set(snapshot.services.map((s) => s.serviceName)),
  ).sort();

  const candidate: CandidateFlag = {
    flagKey: snapshot.flagKey,
    env: snapshot.env,
    winningVariant,
    totalEvaluations,
    evaluatingServices,
    windowDays: snapshot.windowDays,
    firstSeen: snapshot.firstSeen ?? new Date(0).toISOString(),
    lastSeen: snapshot.lastSeen ?? new Date(0).toISOString(),
  };

  return {
    flagKey: snapshot.flagKey,
    env: snapshot.env,
    status: "QUALIFIED",
    candidate,
    reasons: [],
  };
}

/**
 * Batch evaluates an array of flag telemetry snapshots, preserving order.
 */
export function qualifyFlagTelemetryBatch(
  snapshots: FlagTelemetrySnapshot[],
  options?: QualificationOptions,
): QualificationResult[] {
  return snapshots.map((snapshot) =>
    evaluateCandidateQuiescence(snapshot, options),
  );
}
