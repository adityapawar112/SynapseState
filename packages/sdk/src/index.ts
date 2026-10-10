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

// SDK Types & Configurations
export type {
  ActiveLease,
  LeaseStoreMetrics,
  KeysetWatcherOptions,
  EmergencyScannerOptions,
  OverrideProviderOptions,
} from "./types.js";

// Re-export cryptographic lease foundation
export * from "@synapsestate/lease";
