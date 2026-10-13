import fs from "node:fs";
import crypto from "node:crypto";
import { parseKeysetJson, type Keyset } from "@synapsestate/lease";
import type { Logger } from "@openfeature/server-sdk";
import type { KeysetWatcherOptions } from "./types.js";
import {
  type SynapseSdkMetrics,
  safeInvokeMetricCallback,
} from "./metrics.js";

export const DEFAULT_KEYSET_PATH = "/etc/synapse/keyset/keyset.json";
export const DEFAULT_KEYSET_POLL_INTERVAL_MS = 10_000; // 10s per ARCHITECTURE.md:311
export const DEFAULT_KEYSET_MAX_STALE_MS = 15 * 60 * 1000; // 15m per ARCHITECTURE.md:315

export type KeysetWatcherState = "ready" | "stale" | "unreadable";

export interface KeysetWatcherStatus {
  state: KeysetWatcherState;
  lastHash: string;
  keysetAgeSeconds: number;
}

/**
 * Hot-reload watcher monitoring a Git-pinned keyset file mounted from Kubernetes ConfigMap.
 *
 * Implements ARCHITECTURE.md:311-317:
 * - Invariant: Polls SHA-256(fileContent) every 10 seconds.
 * - Explicitly prohibits fs.watch (which fails on Kubernetes symlink atomic swaps).
 * - Bounded Staleness Ceiling: Retains valid in-memory cache for up to 15 minutes during volume turbulence.
 * - Authoritative empty JSON {} immediately executes as "revoke all keys".
 * - Cold-Start Resilience: Boots safely if file is missing without crashing application or probes.
 */
export class KeysetWatcher {
  private readonly keysetPath: string;
  private readonly pollIntervalMs: number;
  private readonly maxStaleMs: number;
  private readonly onKeysetUpdate?: (keyset: Keyset) => void;
  private readonly sdkMetrics?: SynapseSdkMetrics;
  private readonly logger?: Logger;

  private keyset: Keyset = Object.create(null);
  private lastHash = "";
  private lastSuccessfulReadMs = 0;
  private state: KeysetWatcherState = "unreadable";
  private timer?: NodeJS.Timeout;

  constructor(options?: KeysetWatcherOptions) {
    this.keysetPath = options?.keysetPath ?? DEFAULT_KEYSET_PATH;
    this.pollIntervalMs =
      options?.pollIntervalMs ?? DEFAULT_KEYSET_POLL_INTERVAL_MS;
    this.maxStaleMs = options?.maxStaleMs ?? DEFAULT_KEYSET_MAX_STALE_MS;
    this.onKeysetUpdate = options?.onKeysetUpdate;
    this.sdkMetrics = options?.metrics;
    this.logger = options?.logger;
  }

  /**
   * Starts periodic polling and performs an immediate initial read.
   */
  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.pollOnce();

    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stops periodic polling and releases timer resources.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Whether the watcher background timer is active.
   */
  isRunning(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Returns currently active Keyset.
   */
  getKeyset(): Keyset {
    return this.keyset;
  }

  /**
   * Returns current health and staleness status.
   */
  getStatus(): KeysetWatcherStatus {
    const ageSeconds =
      this.lastSuccessfulReadMs > 0
        ? Math.max(
            0,
            Math.floor((Date.now() - this.lastSuccessfulReadMs) / 1000),
          )
        : -1;

    return {
      state: this.state,
      lastHash: this.lastHash,
      keysetAgeSeconds: ageSeconds,
    };
  }

  /**
   * Executes a single poll cycle: reads file, computes SHA-256 hash, parses, and updates state.
   */
  async pollOnce(): Promise<void> {
    try {
      const content = await fs.promises.readFile(this.keysetPath, "utf8");
      const hash = crypto
        .createHash("sha256")
        .update(content, "utf8")
        .digest("hex");

      // File unchanged -> update freshness timestamp and retain ready state
      if (hash === this.lastHash && this.state === "ready") {
        this.lastSuccessfulReadMs = Date.now();
        return;
      }

      // File content changed or initial load -> parse keyset
      try {
        const parsed = parseKeysetJson(content);
        this.keyset = parsed;
        this.lastHash = hash;
        this.lastSuccessfulReadMs = Date.now();
        this.state = "ready";
        try {
          this.onKeysetUpdate?.(this.keyset);
        } catch (cbErr) {
          this.logger?.warn?.(
            `[SynapseState] Error in onKeysetUpdate callback: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
          );
        }
      } catch (parseErr) {
        this.logger?.warn?.(
          `[SynapseState] Failed to parse keyset at ${this.keysetPath}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        );
        this.handleFailureState();
      }
    } catch (readErr) {
      this.logger?.warn?.(
        `[SynapseState] Failed to read keyset file at ${this.keysetPath}: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
      );
      this.handleFailureState();
    } finally {
      const status = this.getStatus();
      safeInvokeMetricCallback(
        this.sdkMetrics?.onKeysetAge,
        status.keysetAgeSeconds,
      );
    }
  }

  /**
   * Handles read or parse failure under bounded cache staleness rules (ARCHITECTURE.md:315).
   */
  private handleFailureState(): void {
    const now = Date.now();
    const hasCachedKeyset = this.lastSuccessfulReadMs > 0;
    const isWithinStalenessWindow =
      hasCachedKeyset && now - this.lastSuccessfulReadMs <= this.maxStaleMs;

    if (isWithinStalenessWindow) {
      // Retain last valid keyset within 15-minute staleness window
      this.state = "stale";
    } else {
      // Staleness ceiling exceeded or cold start: fail-static
      this.state = "unreadable";
      const hadKeys = Object.keys(this.keyset).length > 0;
      this.keyset = Object.create(null);
      this.lastHash = "";

      if (hadKeys) {
        try {
          this.onKeysetUpdate?.(this.keyset);
        } catch (cbErr) {
          this.logger?.warn?.(
            `[SynapseState] Error in onKeysetUpdate callback during fail-static transition: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
          );
        }
      }
    }
  }
}
