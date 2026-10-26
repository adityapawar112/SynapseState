export type UserRole = "viewer" | "operator" | "admin";

export type RolePermission = "read" | "revoke" | "promote" | "admin";

export interface OidcSessionUser {
  id: string;
  login: string;
  name: string;
  avatarUrl?: string;
  email?: string;
  role: UserRole;
  teams?: string[];
  authenticatedAt: string;
  expiresAt: string;
}

export type LeaseStatus =
  "ACTIVE" | "REVOKED" | "EXPIRED" | "SUPERSEDED" | "PROMOTED";

export interface ActiveLeaseView {
  leaseId: string;
  flagKey: string;
  env: string;
  value: unknown;
  reason: string;
  kid: string;
  state?: string;
  status: LeaseStatus;
  issuedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  remainingSeconds: number;
  isNearExpiry: boolean;
  sig: string;
  promotePrUrl?: string;
}

export interface VariantCount {
  variant: string;
  count: number;
}

export interface VariantDistribution {
  variant: string;
  count: number;
  percentage: number;
}

export interface FlagQuiescenceResult {
  isQuiescent: boolean;
  winningVariant?: string;
  isCandidateForPurge: boolean;
}

export interface FlagInventoryView {
  flagKey: string;
  env: string;
  totalEvaluations: number;
  variants: VariantDistribution[];
  activeLease?: ActiveLeaseView;
  isQuiescent: boolean;
  winningVariant?: string;
  isCandidateForPurge: boolean;
  services: string[];
  lastEvaluatedAt?: string;
}

export interface AuditLedgerRecord {
  seq: number;
  ts: string;
  actor: string;
  eventType: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditChainVerificationResult {
  valid: boolean;
  brokenAtSeq?: number;
}

export interface AuditCheckpointView {
  checkpointSeq: number;
  checkpointHash: string;
  sealedCount: number;
  timestamp: string | null;
}

export interface ChangeEventView {
  id: number;
  eventType: string;
  env: string;
  flagKey: string | null;
  actor: string;
  occurredAt: string;
  payload: unknown;
}

export interface DashboardOverview {
  serverTime: string;
  activeLeasesCount: number;
  activeLeases: ActiveLeaseView[];
  totalFlagsCount: number;
  totalEvaluations24h: number;
  sealedAuditCount: number;
  latestCheckpointHash: string;
  latestCheckpointSeq: number;
  controlApiStatus: "healthy" | "degraded" | "unreachable";
  environments: string[];
  selectedEnv: string;
}
