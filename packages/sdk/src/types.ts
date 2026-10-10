import type { Provider, Logger } from "@openfeature/server-sdk";
import type {
  LeaseEnvelope,
  Keyset,
  KeyRevocationPayload,
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
   * Optional logger conforming to OpenFeature Logger interface.
   */
  logger?: Logger;
}
