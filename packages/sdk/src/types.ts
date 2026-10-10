import type { Provider, Logger } from "@openfeature/server-sdk";
import type {
  LeaseEnvelope,
  Keyset,
  KeyRevocationPayload,
  RevocationEnvelope,
  KeyRevocationEnvelope,
} from "@synapsestate/lease";
import type { LeaseStore } from "./lease-store.js";

/**
 * Representation of an active, verified, in-memory emergency override lease.
 */
export interface ActiveLease {
  readonly leaseId: string;
  readonly flagKey: string;
  readonly env: string;
  readonly value:
    boolean | string | number | Record<string, unknown> | unknown[];
  readonly kid: string;
  readonly issuedAt: string;
  readonly ttlSeconds: number;
  readonly firstSeenMonoMs: number;
  readonly effectiveExpiry: Date;
  readonly envelope: LeaseEnvelope;
}

/**
 * Internal metrics and observability counters for LeaseStore operations.
 */
export interface LeaseStoreMetrics {
  activeLeasesCount: number;
  leasesAddedCount: number;
  leasesEvictedExpiredCount: number;
  leasesEvictedRevokedCount: number;
  leasesRejectedCount: number;
  internalErrorsCount: number;
}

/**
 * Configuration options for the Git-pinned KeysetWatcher.
 */
export interface KeysetWatcherOptions {
  /**
   * Absolute path to the Git-pinned keyset JSON file.
   * Default: "/etc/synapse/keyset/keyset.json"
   */
  keysetPath?: string;

  /**
   * Polling interval in milliseconds (ARCHITECTURE.md:311).
   * Default: 10_000 (10 seconds)
   */
  pollIntervalMs?: number;

  /**
   * Maximum cache staleness window in milliseconds before failing static (ARCHITECTURE.md:315).
   * Default: 900_000 (15 minutes)
   */
  maxStaleMs?: number;

  /**
   * Optional callback invoked whenever keyset content updates or changes.
   */
  onKeysetUpdate?: (keyset: Keyset) => void;

  /**
   * Optional logger.
   */
  logger?: Logger;
}

/**
 * Configuration options for the air-gapped EmergencyScanner.
 */
export interface EmergencyScannerOptions {
  /**
   * Directory to scan for signed *.json emergency leases.
   * Default: "/etc/synapse/emergency-leases"
   */
  emergencyDir?: string;

  /**
   * Polling interval in milliseconds.
   * Default: 10_000 (10 seconds)
   */
  pollIntervalMs?: number;

  /**
   * Optional LeaseStore instance to ingest discovered leases into.
   */
  leaseStore?: LeaseStore;

  /**
   * Optional function returning the currently active trusted Keyset.
   */
  getKeyset?: () => Keyset;

  /**
   * Optional function returning currently active key revocations.
   */
  getKeyRevocations?: () => Iterable<KeyRevocationPayload>;

  /**
   * Optional callback when a verified lease is discovered and should be stored.
   */
  onLeaseDiscovered?: (envelope: LeaseEnvelope) => boolean;

  /**
   * Optional logger.
   */
  logger?: Logger;
}

/**
 * State synchronization payload received from GET /v1/sdk/state.
 */
export interface StateSyncPayload {
  server_time: string;
  registry_version: number;
  active_leases: LeaseEnvelope[];
  revocations: RevocationEnvelope[];
  key_revocations: KeyRevocationEnvelope[];
}

/**
 * Configuration options for the ETag long-polling StateClient.
 */
export interface StateClientOptions {
  /**
   * Base URL of the SynapseState Control API (e.g. "http://localhost:3000").
   */
  controlApiUrl: string;

  /**
   * In-memory LeaseStore to reconcile verified leases into.
   */
  leaseStore: LeaseStore;

  /**
   * Target deployment environment to query (e.g. "prod", "staging").
   * Default: "prod"
   */
  env?: string;

  /**
   * Long-poll wait duration in seconds (sent as ?wait={duration}s).
   * Default: 30
   */
  waitSeconds?: number;

  /**
   * Optional bearer service token for authentication.
   */
  serviceToken?: string;

  /**
   * Optional initial ETag value to include in If-None-Match header.
   */
  initialEtag?: string;

  /**
   * Initial backoff delay in ms on network or server error.
   * Default: 1000 (1s)
   */
  backoffInitialMs?: number;

  /**
   * Maximum backoff delay in ms on repeated errors.
   * Default: 30_000 (30s)
   */
  backoffMaxMs?: number;

  /**
   * Optional custom fetch implementation (for testing and dependency injection).
   */
  fetch?: typeof fetch;

  /**
   * Optional logger.
   */
  logger?: Logger;
}

/**
 * Single flag evaluation telemetry counter tuple.
 * Invariant 5: Contains strictly zero context, user IDs, or targeting attributes.
 */
export interface TelemetryMetricItem {
  flag_key: string;
  variant: string;
  reason: string;
  count: number;
}

/**
 * Batch payload sent to POST /v1/telemetry/batches.
 */
export interface TelemetryBatchPayload {
  instance_id: string;
  batch_id: string; // 26-char Crockford ULID
  window_start: string; // ISO 8601
  window_end: string; // ISO 8601
  metrics: TelemetryMetricItem[];
  propagation_lag_ms?: number;
}

/**
 * Configuration options for the zero-context TelemetryHook.
 */
export interface TelemetryHookOptions {
  /**
   * Base URL of the SynapseState Control API (e.g. "http://localhost:3000").
   */
  controlApiUrl?: string;

  /**
   * Unique pod or instance identifier (e.g. "pod-checkout-79b8-x42").
   * Default: os.hostname() or generated unique ID.
   */
  instanceId?: string;

  /**
   * Periodic batch flush interval in milliseconds.
   * Default: 300_000 (5 minutes)
   */
  flushIntervalMs?: number;

  /**
   * Maximum distinct (flag_key, variant, reason) metric tuples retained in memory ring buffer.
   * Default: 5000
   */
  maxDistinctMetrics?: number;

  /**
   * Optional bearer service token for authentication.
   */
  serviceToken?: string;

  /**
   * Function returning the latest measured lease propagation lag in ms.
   */
  getPropagationLagMs?: () => number | undefined;

  /**
   * Optional custom flush handler (useful for testing or out-of-band export).
   */
  onFlush?: (batch: TelemetryBatchPayload) => Promise<void> | void;

  /**
   * Optional custom fetch implementation (for testing and dependency injection).
   */
  fetch?: typeof fetch;

  /**
   * Optional logger.
   */
  logger?: Logger;
}

/**
 * Configuration options for OverrideProvider.
 */
export interface OverrideProviderOptions {
  /**
   * The underlying OpenFeature provider to delegate baseline evaluations to.
   */
  delegate: Provider;

  /**
   * Optional custom LeaseStore instance. If omitted, an internal LeaseStore is created.
   */
  leaseStore?: LeaseStore;

  /**
   * Path to Git-pinned keyset JSON file.
   * Default: "/etc/synapse/keyset/keyset.json"
   */
  keysetPath?: string;

  /**
   * Polling interval for keyset watcher in ms.
   * Default: 10_000 (10s)
   */
  keysetPollIntervalMs?: number;

  /**
   * Keyset fallback cache staleness ceiling in ms.
   * Default: 900_000 (15 minutes)
   */
  keysetCacheMaxStaleMs?: number;

  /**
   * Directory path for air-gapped emergency override files.
   * Default: "/etc/synapse/emergency-leases"
   */
  emergencyDir?: string;

  /**
   * Polling interval for emergency scanner in ms.
   * Default: 10_000 (10s)
   */
  emergencyPollIntervalMs?: number;

  /**
   * Whether to enable the background KeysetWatcher.
   * Default: true
   */
  enableKeysetWatcher?: boolean;

  /**
   * Whether to enable the background EmergencyScanner.
   * Default: true
   */
  enableEmergencyScanner?: boolean;

  /**
   * Clock skew tolerance in milliseconds (Invariant 3).
   * Default: 30_000 (30 seconds)
   */
  skewToleranceMs?: number;

  /**
   * Global maximum allowable TTL in seconds (Invariant 3).
   * Default: 86_400 (24 hours)
   */
  maxTtlSeconds?: number;

  /**
   * Base URL of the SynapseState Control API (e.g. "http://localhost:3000").
   */
  controlApiUrl?: string;

  /**
   * Bearer service token for Control API authentication.
   */
  serviceToken?: string;

  /**
   * Deployment environment name (e.g. "prod", "staging").
   * Default: "prod"
   */
  env?: string;

  /**
   * Duration in seconds for Control API long-polling wait parameter.
   * Default: 30
   */
  longPollWaitSeconds?: number;

  /**
   * Interval in milliseconds for periodic telemetry flushing.
   * Default: 300_000 (5 minutes)
   */
  telemetryFlushIntervalMs?: number;

  /**
   * Workload instance identifier for telemetry reporting.
   */
  instanceId?: string;

  /**
   * Whether to enable ETag long-polling state synchronization client.
   * Default: true if controlApiUrl is provided, false otherwise.
   */
  enableLongPolling?: boolean;

  /**
   * Whether to enable zero-context TelemetryHook.
   * Default: true if controlApiUrl is provided, false otherwise.
   */
  enableTelemetry?: boolean;

  /**
   * Optional custom fetch implementation passed to StateClient and TelemetryHook.
   */
  fetch?: typeof fetch;

  /**
   * Optional logger conforming to OpenFeature Logger interface.
   */
  logger?: Logger;
}
