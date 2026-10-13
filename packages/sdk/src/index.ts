// @synapsestate/sdk — Incident-Safety & Lifecycle Governance for OpenFeature

// Core Override Provider
export { OverrideProvider } from "./provider.js";

// In-Memory Verified Lease Store
export { LeaseStore, type LeaseStoreOptions } from "./lease-store.js";

// Git-Pinned Keyset Hot-Reload Watcher
export {
  KeysetWatcher,
  DEFAULT_KEYSET_PATH,
  DEFAULT_KEYSET_POLL_INTERVAL_MS,
  DEFAULT_KEYSET_MAX_STALE_MS,
  type KeysetWatcherState,
  type KeysetWatcherStatus,
} from "./keyset-watcher.js";

// Air-Gapped Emergency Directory Scanner
export {
  EmergencyScanner,
  DEFAULT_EMERGENCY_DIR,
  DEFAULT_EMERGENCY_POLL_INTERVAL_MS,
  type EmergencyScannerExtendedOptions,
} from "./emergency-scanner.js";

// ETag Long-Polling State Synchronization Client
export {
  StateClient,
  StateSyncPayloadSchema,
  DEFAULT_LONG_POLL_WAIT_SECONDS,
  DEFAULT_BACKOFF_INITIAL_MS,
  DEFAULT_BACKOFF_MAX_MS,
  type StatePollResult,
} from "./state-client.js";

// Zero-Context Telemetry Hook & Aggregator (Invariant 5)
export {
  TelemetryHook,
  DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS,
  DEFAULT_TELEMETRY_MAX_DISTINCT_METRICS,
} from "./telemetry-hook.js";

// Crockford Base32 ULID Generator
export { generateUlid } from "./ulid.js";

// Pluggable SDK Metrics Callbacks (Phase 3 & Invariant 1)
export {
  InMemoryMetricsCollector,
  createInMemoryMetricsCollector,
  safeInvokeMetricCallback,
  type SynapseSdkMetrics,
  type SdkMetricsSnapshot,
} from "./metrics.js";

// SDK Types & Configurations
export type {
  ActiveLease,
  LeaseStoreMetrics,
  KeysetWatcherOptions,
  EmergencyScannerOptions,
  OverrideProviderOptions,
  StateClientOptions,
  StateSyncPayload,
  TelemetryHookOptions,
  TelemetryBatchPayload,
  TelemetryMetricItem,
} from "./types.js";

// Re-export cryptographic lease foundation
export * from "@synapsestate/lease";

