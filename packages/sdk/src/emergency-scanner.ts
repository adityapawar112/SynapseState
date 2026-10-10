import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  LeaseEnvelopeSchema,
  verifyLeaseWithKeyset,
  isKeyRevoked,
  type Keyset,
  type LeaseEnvelope,
  type KeyRevocationPayload,
} from "@synapsestate/lease";
import type { Logger } from "@openfeature/server-sdk";
import type { EmergencyScannerOptions } from "./types.js";
import type { LeaseStore } from "./lease-store.js";

export const DEFAULT_EMERGENCY_DIR = "/etc/synapse/emergency-leases";
export const DEFAULT_EMERGENCY_POLL_INTERVAL_MS = 10_000;

export interface EmergencyScannerExtendedOptions extends EmergencyScannerOptions {
  leaseStore?: LeaseStore;
}

/**
 * Out-of-band air-gapped emergency override channel (ADR 0003, ARCHITECTURE.md:320).
 *
 * Scans a mounted emergency directory for signed break-glass lease files (*.json).
 * Cryptographically verifies each discovered file against the active Git-pinned Keyset
 * using verifyLeaseWithKeyset (enforcing pinned membership, active status, lease_signer role,
 * and max TTL bounds) and verifies against active key revocations before ingesting into LeaseStore.
 */
export class EmergencyScanner {
  private readonly emergencyDir: string;
  private readonly pollIntervalMs: number;
  private readonly leaseStore?: LeaseStore;
  private readonly getKeyset: () => Keyset;
  private readonly getKeyRevocations: () => Iterable<KeyRevocationPayload>;
  private readonly onLeaseDiscovered?: (envelope: LeaseEnvelope) => boolean;
  private readonly logger?: Logger;

  private timer?: NodeJS.Timeout;
  private readonly processedFileHashes = new Map<string, string>();

  constructor(options?: EmergencyScannerExtendedOptions) {
    this.emergencyDir = options?.emergencyDir ?? DEFAULT_EMERGENCY_DIR;
    this.pollIntervalMs =
      options?.pollIntervalMs ?? DEFAULT_EMERGENCY_POLL_INTERVAL_MS;
    this.leaseStore = options?.leaseStore;
    this.logger = options?.logger;
    this.onLeaseDiscovered = options?.onLeaseDiscovered;

    if (options?.getKeyset) {
      this.getKeyset = options.getKeyset;
    } else if (options?.leaseStore) {
      const store = options.leaseStore;
      this.getKeyset = () => store.getKeyset();
    } else {
      this.getKeyset = () => Object.create(null);
    }

    if (options?.getKeyRevocations) {
      this.getKeyRevocations = options.getKeyRevocations;
    } else if (options?.leaseStore) {
      const store = options.leaseStore;
      this.getKeyRevocations = () => store.getKeyRevocations();
    } else {
      this.getKeyRevocations = () => [];
    }
  }

  /**
   * Starts background directory scanning.
   */
  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.scanOnce();

    this.timer = setInterval(() => {
      void this.scanOnce();
    }, this.pollIntervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stops background scanning and releases timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Whether the background timer is running.
   */
  isRunning(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Executes a single directory scan across *.json files.
   * Returns count of valid, newly ingested emergency leases.
   */
  async scanOnce(): Promise<number> {
    try {
      if (!fs.existsSync(this.emergencyDir)) {
        return 0;
      }

      const entries = await fs.promises.readdir(this.emergencyDir, {
        withFileTypes: true,
      });
      const jsonFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => e.name);

      let ingestedCount = 0;
      const currentKeyset = this.getKeyset();
      const currentRevocations = this.getKeyRevocations();

      for (const fileName of jsonFiles) {
        const filePath = path.join(this.emergencyDir, fileName);
        try {
          const content = await fs.promises.readFile(filePath, "utf8");
          const hash = crypto
            .createHash("sha256")
            .update(content, "utf8")
            .digest("hex");

          let parsed: unknown;
          try {
            parsed = JSON.parse(content);
          } catch (jsonErr) {
            this.logger?.warn?.(
              `[SynapseState] Emergency lease file "${fileName}" contains invalid JSON: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
            );
            continue;
          }

          const schemaResult = LeaseEnvelopeSchema.safeParse(parsed);
          if (!schemaResult.success) {
            this.logger?.warn?.(
              `[SynapseState] Emergency lease file "${fileName}" failed schema validation: ${schemaResult.error.message}`,
            );
            continue;
          }

          const envelope = schemaResult.data;

          // Enforce Authoritative Keyset-Policy Seam
          if (!verifyLeaseWithKeyset(envelope, currentKeyset)) {
            this.logger?.warn?.(
              `[SynapseState] Emergency lease file "${fileName}" failed keyset cryptographic policy verification`,
            );
            continue;
          }

          // Enforce Key-Revocation Denial
          if (isKeyRevoked(envelope.payload.kid, currentRevocations)) {
            this.logger?.warn?.(
              `[SynapseState] Emergency lease file "${fileName}" rejected: signing key "${envelope.payload.kid}" is revoked`,
            );
            continue;
          }

          // Ingest into LeaseStore / callback
          let added = false;
          if (this.onLeaseDiscovered) {
            added = this.onLeaseDiscovered(envelope);
          } else if (this.leaseStore) {
            added = this.leaseStore.addLease(envelope, currentKeyset);
          }

          if (added) {
            ingestedCount++;
            this.processedFileHashes.set(fileName, hash);
          }
        } catch (fileErr) {
          this.logger?.warn?.(
            `[SynapseState] Failed reading emergency lease file "${fileName}": ${fileErr instanceof Error ? fileErr.message : String(fileErr)}`,
          );
        }
      }

      return ingestedCount;
    } catch (dirErr) {
      this.logger?.warn?.(
        `[SynapseState] Error scanning emergency directory "${this.emergencyDir}": ${dirErr instanceof Error ? dirErr.message : String(dirErr)}`,
      );
      return 0;
    }
  }
}
