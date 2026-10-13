import { z } from "zod";
import type { Logger } from "@openfeature/server-sdk";
import {
  LeaseEnvelopeSchema,
  RevocationEnvelopeSchema,
  KeyRevocationEnvelopeSchema,
} from "@synapsestate/lease";
import type { LeaseStore } from "./lease-store.js";
import type { StateClientOptions } from "./types.js";
import {
  type SynapseSdkMetrics,
  safeInvokeMetricCallback,
} from "./metrics.js";

/**
 * Zod validation schema for StateSyncPayload received from GET /v1/sdk/state.
 */
export const StateSyncPayloadSchema = z.object({
  server_time: z.string(),
  registry_version: z.number(),
  active_leases: z.array(LeaseEnvelopeSchema),
  revocations: z.array(RevocationEnvelopeSchema),
  key_revocations: z.array(KeyRevocationEnvelopeSchema),
});

export const DEFAULT_LONG_POLL_WAIT_SECONDS = 30;
export const DEFAULT_BACKOFF_INITIAL_MS = 1000;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;

export interface StatePollResult {
  status: 200 | 304 | "error";
  etag?: string;
  error?: unknown;
}

/**
 * ETag Long-Polling State Synchronization Client.
 *
 * Implements ADR 0003 & ARCHITECTURE §5.1-5.4:
 * - Unified wire contract: GET /v1/sdk/state?env={env}&wait={waitSeconds}s
 * - Sends If-None-Match: "<etag>" and Authorization: Bearer <service_token>
 * - Ingests active leases, revocations, and key revocations into LeaseStore in strict cryptographic order.
 * - Fail-Static Offline Resilience: Network failures or 5xx server errors do NOT clear active leases.
 * - Exponential backoff with jitter on connection errors.
 * - Clean lifecycle with AbortController.
 */
export class StateClient {
  private readonly controlApiUrl: string;
  private readonly leaseStore: LeaseStore;
  private readonly env: string;
  private readonly waitSeconds: number;
  private readonly serviceToken?: string;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sdkMetrics?: SynapseSdkMetrics;
  private readonly logger?: Logger;

  private running = false;
  private abortController?: AbortController;
  private currentEtag?: string;
  private lastSyncTime?: Date;
  private lastPropagationLagMs?: number;
  private currentBackoffMs: number;
  private loopPromise?: Promise<void>;

  constructor(options: StateClientOptions) {
    this.controlApiUrl = options.controlApiUrl.replace(/\/+$/, "");
    this.leaseStore = options.leaseStore;
    this.env = options.env ?? "prod";
    this.waitSeconds = options.waitSeconds ?? DEFAULT_LONG_POLL_WAIT_SECONDS;
    this.serviceToken = options.serviceToken;
    this.currentEtag = options.initialEtag;
    this.backoffInitialMs =
      options.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.sdkMetrics = options.metrics;
    this.logger = options.logger;

    this.currentBackoffMs = this.backoffInitialMs;
  }

  /**
   * Whether the background long-polling loop is active.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Returns current active ETag string.
   */
  getCurrentEtag(): string | undefined {
    return this.currentEtag;
  }

  /**
   * Returns timestamp of last successful state sync or 304 response.
   */
  getLastSyncTime(): Date | undefined {
    return this.lastSyncTime;
  }

  /**
   * Returns last measured lease propagation lag in milliseconds.
   * Returns undefined if no successful HTTP 200 sync has completed yet.
   */
  getLastPropagationLagMs(): number | undefined {
    return this.lastPropagationLagMs;
  }

  /**
   * Executes a single state polling cycle.
   */
  async pollOnce(externalSignal?: AbortSignal): Promise<StatePollResult> {
    const activeSignal = externalSignal ?? this.abortController?.signal;

    try {
      const url = `${this.controlApiUrl}/v1/sdk/state?env=${encodeURIComponent(this.env)}&wait=${this.waitSeconds}s`;
      const headers: Record<string, string> = {
        Accept: "application/json",
      };

      if (this.currentEtag) {
        headers["If-None-Match"] = this.currentEtag;
      }
      if (this.serviceToken) {
        headers["Authorization"] = `Bearer ${this.serviceToken}`;
      }

      const response = await this.fetchFn(url, {
        method: "GET",
        headers,
        signal: activeSignal,
      });

      // 1. HTTP 304 Not Modified
      if (response.status === 304) {
        this.lastSyncTime = new Date();
        this.currentBackoffMs = this.backoffInitialMs;
        safeInvokeMetricCallback(this.sdkMetrics?.onStateAge, 0);
        return { status: 304, etag: this.currentEtag };
      }

      // 2. HTTP 200 OK
      if (response.status === 200) {
        const newEtag =
          response.headers.get("etag") ?? response.headers.get("ETag");
        if (newEtag) {
          this.currentEtag = newEtag;
        }

        this.lastSyncTime = new Date();
        this.currentBackoffMs = this.backoffInitialMs;
        safeInvokeMetricCallback(this.sdkMetrics?.onStateAge, 0);

        let rawBody: unknown;
        try {
          rawBody = await response.json();
        } catch (jsonErr) {
          this.logger?.warn?.(
            `[SynapseState] Failed to parse JSON from State API: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
          );
          safeInvokeMetricCallback(this.sdkMetrics?.onPollError, {
            reason: "PARSE_ERROR",
          });
          return { status: "error", error: jsonErr };
        }

        const parseResult = StateSyncPayloadSchema.safeParse(rawBody);
        if (!parseResult.success) {
          this.logger?.warn?.(
            `[SynapseState] Invalid state sync payload schema: ${parseResult.error.message}`,
          );
          safeInvokeMetricCallback(this.sdkMetrics?.onPollError, {
            reason: "SCHEMA_ERROR",
          });
          return { status: "error", error: parseResult.error };
        }

        const payload = parseResult.data;

        // Track propagation lag based on server timestamp
        const serverMs = Date.parse(payload.server_time);
        if (!Number.isNaN(serverMs)) {
          this.lastPropagationLagMs = Math.max(0, Date.now() - serverMs);
        }

        // Cryptographically reconcile into LeaseStore:
        // 1. Apply key revocations first
        for (const keyRevocation of payload.key_revocations) {
          this.leaseStore.applyKeyRevocation(keyRevocation);
        }

        // 2. Apply lease revocations second
        for (const revocation of payload.revocations) {
          this.leaseStore.applyRevocation(revocation);
        }

        // 3. Add active leases third
        for (const lease of payload.active_leases) {
          this.leaseStore.addLease(lease);
        }

        return { status: 200, etag: this.currentEtag };
      }

      // 3. HTTP 401 / 403 Authentication / Authorization failure
      if (response.status === 401 || response.status === 403) {
        this.logger?.warn?.(
          `[SynapseState] State API returned HTTP ${response.status} (Authentication/Authorization failure). Verify serviceToken configuration. Existing active leases continue to be honored fail-static until TTL expiration.`,
        );
        safeInvokeMetricCallback(this.sdkMetrics?.onPollError, {
          reason: "AUTH_ERROR",
        });
        return { status: "error" };
      }

      // 4. Non-200 / Non-304 HTTP errors (e.g. 500, 502, 503)
      this.logger?.warn?.(
        `[SynapseState] State API returned HTTP ${response.status} ${response.statusText ?? ""}`,
      );
      safeInvokeMetricCallback(this.sdkMetrics?.onPollError, {
        reason: `HTTP_${response.status}`,
      });
      return { status: "error" };
    } catch (err) {
      const isAborted =
        activeSignal?.aborted ||
        externalSignal?.aborted ||
        this.abortController?.signal.aborted ||
        (err instanceof Error &&
          (err.name === "AbortError" ||
            err.message.toLowerCase().includes("aborted")));

      if (isAborted) {
        return { status: "error", error: err };
      }

      this.logger?.warn?.(
        `[SynapseState] State client poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      safeInvokeMetricCallback(this.sdkMetrics?.onPollError, {
        reason: "NETWORK_ERROR",
      });
      return { status: "error", error: err };
    }
  }

  /**
   * Starts the continuous background long-polling loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    this.loopPromise = this.runLoop();
  }

  /**
   * Stops the background long-polling loop and aborts any in-flight HTTP request.
   * Awaits completion of the running loop promise to guarantee clean shutdown.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    const controller = this.abortController;
    controller?.abort();

    try {
      if (this.loopPromise) {
        await this.loopPromise;
      }
    } finally {
      this.abortController = undefined;
      this.loopPromise = undefined;
    }
  }

  /**
   * Background polling loop with exponential backoff and jitter on error.
   */
  private async runLoop(): Promise<void> {
    while (this.running) {
      const signal = this.abortController?.signal;
      if (signal?.aborted) {
        break;
      }

      try {
        const result = await this.pollOnce(signal);

        if (!this.running || signal?.aborted) {
          break;
        }

        if (result.status === "error") {
          // Exponential backoff with jitter
          const jitter = 0.8 + Math.random() * 0.4;
          const delay = Math.round(this.currentBackoffMs * jitter);
          this.currentBackoffMs = Math.min(
            this.backoffMaxMs,
            this.currentBackoffMs * 2,
          );

          await this.sleep(delay, signal);
        } else {
          // Immediate re-issue of next poll on 200 or 304
          this.currentBackoffMs = this.backoffInitialMs;
        }
      } catch {
        if (!this.running || signal?.aborted) {
          break;
        }
        await this.sleep(this.currentBackoffMs, signal);
      }
    }
  }

  /**
   * Abortable sleep helper for backoff delays.
   * Cleans up signal listener to avoid memory leaks during long-running backoff loops.
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      function onAbort(): void {
        clearTimeout(timer);
        resolve();
      }

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
