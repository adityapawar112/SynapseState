/**
 * Pluggable metrics interface for SynapseState OpenFeature SDK.
 *
 * Implements ARCHITECTURE §11.1 & Phase 3 Observability:
 * - Vendor-neutral: No hard dependency on Prometheus, OpenTelemetry, or any third-party agent.
 * - Zero-Context Privacy (Invariant 5): strictly bounded dimensions (status_code, reason),
 *   never user IDs, targeting attributes, or flag values.
 * - Fail-Safe (Invariant 1): Callback invocations are isolated so errors in metric collectors
 *   never disrupt flag evaluation or state polling.
 */
export interface SynapseSdkMetrics {
  /**
   * Invoked with the elapsed seconds since the most recent state synchronization
   * (synapse_sdk_state_age_seconds).
   */
  onStateAge?: (seconds: number) => void;

  /**
   * Invoked with the elapsed seconds since the last successful keyset read from disk
   * (synapse_sdk_keyset_age_seconds), or -1 if no valid keyset has ever been loaded (cold start).
   */
  onKeysetAge?: (seconds: number) => void;

  /**
   * Invoked with the count of currently active in-memory overrides
   * (synapse_sdk_active_overrides).
   */
  onActiveOverrides?: (count: number) => void;

  /**
   * Invoked when a state polling request encounters a network or HTTP error
   * (synapse_sdk_poll_errors_total).
   */
  onPollError?: (details?: { reason?: string }) => void;

  /**
   * Invoked when telemetry metric tuples are dropped by bulkhead capacity protection
   * (synapse_sdk_telemetry_dropped_total).
   */
  onTelemetryDropped?: (droppedCount: number) => void;
}

/**
 * Snapshot representation of SDK metrics counters and gauges.
 */
export interface SdkMetricsSnapshot {
  stateAgeSeconds: number;
  keysetAgeSeconds: number;
  activeOverrides: number;
  pollErrorsTotal: number;
  telemetryDroppedTotal: number;
}

/**
 * In-memory reference implementation of SynapseSdkMetrics.
 * Collects metrics into memory and provides snapshot inspection for testing,
 * health checks, or custom telemetry bridges.
 */
export class InMemoryMetricsCollector implements SynapseSdkMetrics {
  private stateAge = 0;
  private keysetAge = 0;
  private activeOverridesCount = 0;
  private pollErrorsCount = 0;
  private telemetryDroppedCount = 0;

  onStateAge = (seconds: number): void => {
    this.stateAge = Math.max(0, seconds);
  };

  onKeysetAge = (seconds: number): void => {
    // -1 explicitly represents cold start sentinel; otherwise non-negative elapsed seconds
    this.keysetAge = seconds < 0 ? -1 : Math.max(0, seconds);
  };

  onActiveOverrides = (count: number): void => {
    this.activeOverridesCount = Math.max(0, count);
  };

  onPollError = (_details?: { reason?: string }): void => {
    this.pollErrorsCount++;
  };

  onTelemetryDropped = (droppedCount: number): void => {
    if (droppedCount > 0) {
      this.telemetryDroppedCount += droppedCount;
    }
  };

  /**
   * Returns current snapshot of all SDK metrics.
   */
  getSnapshot(): SdkMetricsSnapshot {
    return {
      stateAgeSeconds: this.stateAge,
      keysetAgeSeconds: this.keysetAge,
      activeOverrides: this.activeOverridesCount,
      pollErrorsTotal: this.pollErrorsCount,
      telemetryDroppedTotal: this.telemetryDroppedCount,
    };
  }
}

/**
 * Factory creating an in-memory metrics collector instance.
 */
export function createInMemoryMetricsCollector(): InMemoryMetricsCollector {
  return new InMemoryMetricsCollector();
}

/**
 * Defensive invocation wrapper that prevents user-supplied metric callback
 * exceptions from impacting SDK evaluation or lifecycle threads.
 */
export function safeInvokeMetricCallback<Args extends unknown[]>(
  fn?: ((...args: Args) => void) | null,
  ...args: Args
): void {
  if (!fn) {
    return;
  }
  try {
    fn(...args);
  } catch {
    // Invariant 1: Fail-safe containment — metric hook failures must never crash the SDK
  }
}
