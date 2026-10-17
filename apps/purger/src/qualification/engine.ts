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

/**
 * Evaluates a single flag's telemetry snapshot against the quiescence rule matrix:
 * 1. Lifecycle Class: class === 'release' (killswitch and permanent flags excluded).
 * 2. Invariance Window: served a single variant continuously for >= minWindowDays (or 0 evaluations across entire window).
 * 3. Consumer Coverage: 100% of evaluating consumer services have status IN ('ACTIVE', 'RETIRED').
 *    Any service with status 'SILENT' blocks qualification and is recorded in blockingServices.
 * 4. Lease Quiescence: zero active emergency leases.
 * 5. Winning Variant: single invariant variant, or verified defaultVariant when 0 evaluations.
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

  // 4. Observation Window & Telemetry Span Check
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

  // If the flag recorded evaluations, verify that telemetry span spans >= minWindowDays
  if (activeVariants.length > 0) {
    if (snapshot.firstSeen && snapshot.lastSeen) {
      const first = new Date(snapshot.firstSeen).getTime();
      const last = new Date(snapshot.lastSeen).getTime();
      const spanDays = Math.floor((last - first) / (86400 * 1000));
      if (
        spanDays < minWindowDays &&
        !reasons.includes("INSUFFICIENT_WINDOW")
      ) {
        reasons.push("INSUFFICIENT_WINDOW");
      }
    } else if (!reasons.includes("INSUFFICIENT_WINDOW")) {
      reasons.push("INSUFFICIENT_WINDOW");
    }
  }

  if (activeVariants.length > 1) {
    reasons.push("MULTI_VARIANT_ACTIVE");
  }

  // 6. Winning Variant Determination (Fail-closed on 0-eval flags without defaultVariant)
  let winningVariant: string | undefined;
  if (activeVariants.length === 1) {
    winningVariant = activeVariants[0].variant;
  } else if (activeVariants.length === 0) {
    if (!snapshot.defaultVariant) {
      reasons.push("MISSING_DEFAULT_VARIANT");
    } else {
      winningVariant = snapshot.defaultVariant;
    }
  }

  // If disqualified, return early with all accumulated reasons and blocking services
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

  const evaluatingServices = Array.from(
    new Set(snapshot.services.map((s) => s.serviceName)),
  ).sort();

  const candidate: CandidateFlag = {
    flagKey: snapshot.flagKey,
    env: snapshot.env,
    winningVariant: winningVariant!,
    totalEvaluations,
    evaluatingServices,
    windowDays: snapshot.windowDays,
    ...(snapshot.firstSeen ? { firstSeen: snapshot.firstSeen } : {}),
    ...(snapshot.lastSeen ? { lastSeen: snapshot.lastSeen } : {}),
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
 * Batch evaluates an array of flag telemetry snapshots, preserving order
 * and ensuring input array immutability.
 */
export function qualifyFlagTelemetryBatch(
  snapshots: readonly FlagTelemetrySnapshot[],
  options?: QualificationOptions,
): QualificationResult[] {
  return snapshots.map((snapshot) =>
    evaluateCandidateQuiescence(snapshot, options),
  );
}
