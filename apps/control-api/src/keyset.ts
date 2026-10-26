import fs from "node:fs";
import { parseKeysetJson, type Keyset } from "@synapsestate/lease";

export const DEFAULT_KEYSET_PATH = "/etc/synapse/keyset/keyset.json";

export interface KeysetProvider {
  getKeyset(): Keyset;
}

/**
 * Keyset provider backed by an in-memory Keyset object.
 * Useful for tests and static configurations. Automatically normalizes roles and status.
 */
export class StaticKeysetProvider implements KeysetProvider {
  private readonly keyset: Keyset;

  constructor(keyset: Record<string, unknown> | Keyset) {
    this.keyset = parseKeysetJson(JSON.stringify(keyset));
  }

  getKeyset(): Keyset {
    return this.keyset;
  }
}

/**
 * Keyset provider that reads and parses a Git-pinned keyset file from disk.
 *
 * Implements ARCHITECTURE §3.1 & Invariant 2:
 * - Cold-Start Resilience: If the keyset file is not present on disk, returns an empty
 *   keyset `{}` and does not crash the server or health probes.
 * - Parses keyset JSON using parseKeysetJson() from @synapsestate/lease.
 */
export class FileKeysetProvider implements KeysetProvider {
  private readonly filePath: string;
  private cachedKeyset: Keyset = Object.create(null);
  private lastMtimeMs = 0;

  constructor(filePath?: string) {
    this.filePath = filePath || process.env.KEYSET_PATH || DEFAULT_KEYSET_PATH;
  }

  getKeyset(): Keyset {
    try {
      if (!fs.existsSync(this.filePath)) {
        return Object.create(null);
      }

      const stat = fs.statSync(this.filePath);
      if (stat.mtimeMs !== this.lastMtimeMs) {
        const content = fs.readFileSync(this.filePath, "utf-8");
        this.cachedKeyset = parseKeysetJson(content);
        this.lastMtimeMs = stat.mtimeMs;
      }

      return this.cachedKeyset;
    } catch (err) {
      console.warn(
        `[SynapseState] Failed reading keyset file at ${this.filePath}:`,
        err,
      );
      return this.cachedKeyset;
    }
  }
}

export function createKeysetProvider(options?: {
  keyset?: Record<string, unknown> | Keyset;
  keysetPath?: string;
}): KeysetProvider {
  if (options?.keyset) {
    return new StaticKeysetProvider(options.keyset);
  }
  return new FileKeysetProvider(options?.keysetPath);
}
