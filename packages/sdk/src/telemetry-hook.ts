import os from "node:os";
import type {
  Hook,
  HookContext,
  EvaluationDetails,
  FlagValue,
  Logger,
} from "@openfeature/server-sdk";
import type {
  TelemetryHookOptions,
  TelemetryBatchPayload,
  TelemetryMetricItem,
} from "./types.js";
import { generateUlid } from "./ulid.js";
import {
  type SynapseSdkMetrics,
  safeInvokeMetricCallback,
} from "./metrics.js";

export const DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS = 300_000; // 5 minutes
export const DEFAULT_TELEMETRY_MAX_DISTINCT_METRICS = 5000;

interface MetricTuple {
  flagKey: string;
  variant: string;
  reason: string;
  count: number;
}

/**
 * OpenFeature TelemetryHook implementing Invariant 5 (Zero-Context Privacy).
 *
 * Captures strictly (flag_key, variant, reason) evaluation count tuples in memory.
 * Never accesses, inspects, or egresses hookContext.context or user targeting attributes.
 * Periodically flushes aggregated batches to POST /v1/telemetry/batches with ring-buffer bulkhead limits.
 */
export class TelemetryHook implements Hook {
  private readonly controlApiUrl?: string;
  private readonly instanceId: string;
  private readonly flushIntervalMs: number;
  private readonly maxDistinctMetrics: number;
  private readonly serviceToken?: string;
  private readonly getPropagationLagMs?: () => number | undefined;
  private readonly onFlush?: (
    batch: TelemetryBatchPayload,
  ) => Promise<void> | void;
  private readonly fetchFn: typeof fetch;
  private readonly sdkMetrics?: SynapseSdkMetrics;
  private readonly logger?: Logger;

  private metricsMap = new Map<string, MetricTuple>();
  private droppedCount = 0;
  private windowStart: string;
  private timer?: NodeJS.Timeout;

  constructor(options?: TelemetryHookOptions) {
    this.controlApiUrl = options?.controlApiUrl?.replace(/\/+$/, "");
    this.instanceId =
      options?.instanceId ?? os.hostname() ?? "synapse-sdk-instance";
    this.flushIntervalMs =
      options?.flushIntervalMs ?? DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS;
    this.maxDistinctMetrics =
      options?.maxDistinctMetrics ?? DEFAULT_TELEMETRY_MAX_DISTINCT_METRICS;
    this.serviceToken = options?.serviceToken;
    this.getPropagationLagMs = options?.getPropagationLagMs;
    this.onFlush = options?.onFlush;
    this.fetchFn = options?.fetch ?? globalThis.fetch;
    this.sdkMetrics = options?.metrics;
    this.logger = options?.logger;

    this.windowStart = new Date().toISOString();
  }

  /**
   * Returns current pod/workload instance ID.
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Returns current count of distinct (flag_key, variant, reason) metric tuples in memory.
   */
  getDistinctCount(): number {
    return this.metricsMap.size;
  }

  /**
   * Returns total count of tuples dropped by bulkhead capacity protection in the current window.
   */
  getDroppedCount(): number {
    return this.droppedCount;
  }

  /**
   * Invariant 5 (Zero-Context Privacy):
   * Collect ONLY flagKey, variant, and reason code. NEVER inspect or serialize hookContext.context.
   */
  after(
    hookContext: Readonly<HookContext>,
    evaluationDetails: EvaluationDetails<FlagValue>,
  ): void {
    const flagKey = hookContext.flagKey;
    const variant =
      evaluationDetails.variant ??
      (evaluationDetails.value !== undefined
        ? String(evaluationDetails.value)
        : "unknown");
    const reason = evaluationDetails.reason ?? "UNKNOWN";

    this.recordEvaluation(flagKey, variant, reason);
  }

  /**
   * Invariant 5 (Zero-Context Privacy):
   * Record error evaluations with variant='error' and reason='ERROR'.
   */
  error(hookContext: Readonly<HookContext>, _error: unknown): void {
    this.recordEvaluation(hookContext.flagKey, "error", "ERROR");
  }

  /**
   * Records an evaluation count in the in-memory ring buffer.
   * Enforces bulkhead limits against high-cardinality flags.
   */
  private recordEvaluation(
    flagKey: string,
    variant: string,
    reason: string,
  ): void {
    const compositeKey = `${flagKey}\0${variant}\0${reason}`;
    const existing = this.metricsMap.get(compositeKey);

    if (existing) {
      existing.count++;
    } else {
      if (this.metricsMap.size < this.maxDistinctMetrics) {
        this.metricsMap.set(compositeKey, {
          flagKey,
          variant,
          reason,
          count: 1,
        });
      } else {
        // Bulkhead capacity ceiling reached: drop new distinct tuple to preserve process memory
        this.droppedCount++;
        safeInvokeMetricCallback(this.sdkMetrics?.onTelemetryDropped, 1);
      }
    }
  }

  /**
   * Starts periodic batch flushing.
   */
  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stops periodic batch flushing and drains any remaining buffered metrics.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    await this.flush();
  }

  /**
   * Flushes current metric window into a sorted TelemetryBatchPayload.
   * Sends batch to POST /v1/telemetry/batches if controlApiUrl is configured.
   */
  async flush(): Promise<TelemetryBatchPayload | undefined> {
    if (this.metricsMap.size === 0) {
      this.windowStart = new Date().toISOString();
      this.droppedCount = 0;
      return undefined;
    }

    const currentMap = this.metricsMap;
    const currentWindowStart = this.windowStart;
    const currentWindowEnd = new Date().toISOString();
    const currentDroppedCount = this.droppedCount;

    // Reset buffer for the next collection window
    this.metricsMap = new Map();
    this.windowStart = currentWindowEnd;
    this.droppedCount = 0;

    if (currentDroppedCount > 0) {
      this.logger?.warn?.(
        `[SynapseState] Telemetry bulkhead limit reached: dropped ${currentDroppedCount} distinct metric tuples in window`,
      );
    }

    // Convert map to metrics list
    const metrics: TelemetryMetricItem[] = [];
    for (const tuple of currentMap.values()) {
      metrics.push({
        flag_key: tuple.flagKey,
        variant: tuple.variant,
        reason: tuple.reason,
        count: tuple.count,
      });
    }

    // Deterministic sorting: flag_key ASC, variant ASC, reason ASC
    metrics.sort((a, b) => {
      const cmpFlag = a.flag_key.localeCompare(b.flag_key);
      if (cmpFlag !== 0) return cmpFlag;
      const cmpVariant = a.variant.localeCompare(b.variant);
      if (cmpVariant !== 0) return cmpVariant;
      return a.reason.localeCompare(b.reason);
    });

    const batchId = generateUlid();
    const propagationLagMs = this.getPropagationLagMs?.();

    const batch: TelemetryBatchPayload = {
      instance_id: this.instanceId,
      batch_id: batchId,
      window_start: currentWindowStart,
      window_end: currentWindowEnd,
      metrics,
      ...(propagationLagMs !== undefined ? { propagation_lag_ms: propagationLagMs } : {}),
      ...(currentDroppedCount > 0 ? { dropped_count: currentDroppedCount } : {}),
    };

    // Invoke custom onFlush hook if registered
    if (this.onFlush) {
      try {
        await this.onFlush(batch);
      } catch (err) {
        this.logger?.warn?.(
          `[SynapseState] Error in custom telemetry onFlush callback: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Export batch via HTTP if controlApiUrl is configured
    if (this.controlApiUrl) {
      try {
        const url = `${this.controlApiUrl}/v1/telemetry/batches`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (this.serviceToken) {
          headers["Authorization"] = `Bearer ${this.serviceToken}`;
        }

        await this.fetchFn(url, {
          method: "POST",
          headers,
          body: JSON.stringify(batch),
        });
      } catch (err) {
        this.logger?.warn?.(
          `[SynapseState] Failed to export telemetry batch to ${this.controlApiUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return batch;
  }
}
