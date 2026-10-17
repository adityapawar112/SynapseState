/**
 * Domain Models for SynapseState Purger Quiescence & Candidate Qualification Engine.
 *
 * Implements authoritative domain vocabulary and data contracts as defined in:
 * - AGENTS.md (§1 Non-Goals, §2 Architectural Invariants 1-8)
 * - docs/ARCHITECTURE.md (§9 Telemetry-Driven Stale Detection & Scanner)
 * - GLOSSARY.md
 */

export type FlagLifecycleClass = "release" | "killswitch" | "permanent";

export type ServiceStatus = "ACTIVE" | "SILENT" | "RETIRED";

export type QualificationStatus = "QUALIFIED" | "DISQUALIFIED";

export type DisqualificationReason =
  | "EXCLUDED_LIFECYCLE_CLASS"
  | "MULTI_VARIANT_ACTIVE"
  | "INSUFFICIENT_WINDOW"
  | "BLOCKED_BY_SILENT_SERVICE"
  | "ACTIVE_LEASE_EXISTS"
  | "UNREGISTERED_FLAG"
  | "MISSING_DEFAULT_VARIANT";

/**
 * Represents a qualified stale flag candidate ready for AST code scanning and retirement.
 */
export interface CandidateFlag {
  flagKey: string;
  env: string;
  winningVariant: string;
  totalEvaluations: number;
  evaluatingServices: string[];
  windowDays: number;
  firstSeen?: string;
  lastSeen?: string;
}

/**
 * Result of evaluating a flag telemetry snapshot against the quiescence rule matrix.
 */
export interface QualificationResult {
  flagKey: string;
  env: string;
  status: QualificationStatus;
  candidate?: CandidateFlag;
  reasons: DisqualificationReason[];
  blockingServices?: string[];
}

/**
 * Variant evaluation metric aggregated over the quiescence observation window.
 */
export interface VariantEvaluation {
  variant: string;
  evalCount: number;
  firstSeen?: string;
  lastSeen?: string;
}

/**
 * Consumer service evaluation metric and health status.
 */
export interface ConsumerServiceEvaluation {
  serviceName: string;
  status: ServiceStatus;
  evalCount?: number;
  lastSeen?: string;
}

/**
 * Point-in-time telemetry and state snapshot for a single feature flag across an environment.
 */
export interface FlagTelemetrySnapshot {
  flagKey: string;
  env: string;
  flagClass?: FlagLifecycleClass;
  defaultVariant?: string;
  hasActiveLease: boolean;
  windowDays: number;
  firstSeen?: string;
  lastSeen?: string;
  variants: VariantEvaluation[];
  services: ConsumerServiceEvaluation[];
}

/**
 * Configuration options for the qualification engine.
 */
export interface QualificationOptions {
  /**
   * Minimum observation window in days required to prove quiescence (default: 35).
   */
  minWindowDays?: number;

  /**
   * Maximum observation window in days (default: 45).
   */
  maxWindowDays?: number;

  /**
   * Optional reference timestamp for deterministic time calculations.
   */
  now?: Date | string;
}

/**
 * Database client contract compatible with pg.Pool and pg.Client.
 */
export interface Queryable {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Options for rollup queries.
 */
export interface RollupQueryOptions {
  windowDays?: number;
  env?: string;
  flagKey?: string;
}

/**
 * Raw row shape returned by the quiescence SQL rollup query.
 */
export interface RawRollupRow {
  flag_key: string;
  env: string;
  flag_class: FlagLifecycleClass | null;
  flag_created_at: string | Date | null;
  actual_window_days?: number | string | null;
  has_active_lease: boolean;
  variants: Array<{
    variant: string;
    evalCount: number | string;
    firstSeen?: string | null;
    lastSeen?: string | null;
  }>;
  services: Array<{
    serviceName: string;
    status: ServiceStatus;
    evalCount?: number | string;
    lastSeen?: string | null;
  }>;
}
