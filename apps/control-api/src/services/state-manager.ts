import crypto from "node:crypto";
import type { Pool } from "pg";
import {
  canonicalizeJson,
  type LeaseEnvelope,
  type RevocationEnvelope,
  type KeyRevocationEnvelope,
} from "@synapsestate/lease";

export interface StateDeliveryPayload {
  etag: string;
  server_time: string;
  registry_version: number;
  active_leases: LeaseEnvelope[];
  revocations: RevocationEnvelope[];
  key_revocations: KeyRevocationEnvelope[];
}

export interface CachedState {
  etag: string;
  registryVersion: number;
  activeLeases: LeaseEnvelope[];
  revocations: RevocationEnvelope[];
  keyRevocations: KeyRevocationEnvelope[];
  expiresAtMs: number;
  fetchedAtMs: number;
}

export type WaiterCallback = (state: CachedState) => void;

/**
 * Normalizes an ETag string by stripping quotes and weak indicator (W/).
 */
export function normalizeEtag(etag?: string | null): string {
  if (!etag) return "";
  let clean = etag.trim();
  if (clean.startsWith("W/")) {
    clean = clean.slice(2);
  }
  if (clean.startsWith('"') && clean.endsWith('"') && clean.length >= 2) {
    clean = clean.slice(1, -1);
  }
  return clean;
}

/**
 * Computes a deterministic SHA-256 ETag from canonicalized state components.
 */
export function computeStateEtag(
  activeLeases: LeaseEnvelope[],
  revocations: RevocationEnvelope[],
  keyRevocations: KeyRevocationEnvelope[],
  registryVersion: number
): string {
  const canonical = canonicalizeJson({
    active_leases: activeLeases,
    key_revocations: keyRevocations,
    registry_version: registryVersion,
    revocations,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * In-Memory State Manager & Long-Polling Coordinator.
 *
 * Implements ARCHITECTURE §4.1 & ADR 0003:
 * - Caches active leases, bounded revocations, and key revocations per environment in Node.js memory.
 * - Generates deterministic RFC 8785 ETags.
 * - Serves 304 Not Modified immediately from memory when wait=0 or when client ETag matches.
 * - Suspends long-polling requests up to wait seconds (default 30s, max 60s).
 * - Instant wake-up (<100ms) upon lease ingestion or revocation via in-memory event dispatch.
 * - Prevents database stampedes using single-flight query coalescing.
 */
export class StateManager {
  private readonly pool: Pool;
  private readonly cache = new Map<string, CachedState>();
  private readonly waiters = new Map<string, Set<WaiterCallback>>();
  private readonly inFlight = new Map<string, Promise<CachedState>>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Retrieves the current cached state for an environment.
   * If cache is cold or expired, loads state from PostgreSQL.
   */
  async getState(env: string, forceRefresh = false): Promise<CachedState> {
    const now = Date.now();
    const existing = this.cache.get(env);

    if (!forceRefresh && existing && now < existing.expiresAtMs) {
      return existing;
    }

    // Coalesce concurrent queries for the same env
    const existingPromise = this.inFlight.get(env);
    if (existingPromise) {
      return existingPromise;
    }

    const queryPromise = this.loadStateFromDb(env).finally(() => {
      this.inFlight.delete(env);
    });

    this.inFlight.set(env, queryPromise);
    return queryPromise;
  }

  private async loadStateFromDb(env: string): Promise<CachedState> {
    const client = await this.pool.connect();
    try {
      // 1. Query active leases for this environment that have not yet expired
      const leasesRes = await client.query<{ payload: unknown; sig: string; expires_at: Date }>(
        `SELECT payload, sig, expires_at 
         FROM leases 
         WHERE env = $1 AND state = 'ACTIVE' AND expires_at > NOW() 
         ORDER BY lease_id ASC`,
        [env]
      );

      const activeLeases: LeaseEnvelope[] = leasesRes.rows.map((row) => ({
        payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as LeaseEnvelope["payload"],
        sig: row.sig,
      }));

      // 2. Query unexpired revocations (bounded retention per ARCHITECTURE §4.1)
      const revocationsRes = await client.query<{ payload: unknown; sig: string; expires_at: Date }>(
        `SELECT payload, sig, expires_at 
         FROM revocations 
         WHERE expires_at >= NOW() 
         ORDER BY lease_id ASC`
      );

      const revocations: RevocationEnvelope[] = revocationsRes.rows.map((row) => ({
        payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as RevocationEnvelope["payload"],
        sig: row.sig,
      }));

      // 3. Query fast-path key revocations
      const keyRevRes = await client.query<{ payload: unknown; sig: string }>(
        `SELECT payload, sig 
         FROM key_revocations 
         ORDER BY kid ASC`
      );

      const keyRevocations: KeyRevocationEnvelope[] = keyRevRes.rows.map((row) => ({
        payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as KeyRevocationEnvelope["payload"],
        sig: row.sig,
      }));

      // 4. Query max registry_version for flags in this environment
      const flagRes = await client.query<{ version: string | number }>(
        `SELECT COALESCE(MAX(registry_version), 1)::bigint AS version 
         FROM flags 
         WHERE env = $1`,
        [env]
      );

      const registryVersion = Number(flagRes.rows[0]?.version ?? 1);

      // Compute deterministic ETag
      const etag = computeStateEtag(activeLeases, revocations, keyRevocations, registryVersion);

      // Determine next expiration boundary to avoid serving expired state from cache
      let minExpiresAtMs = Date.now() + 60_000; // default 60s cache ceiling
      for (const row of leasesRes.rows) {
        const rowExp = new Date(row.expires_at).getTime();
        if (rowExp < minExpiresAtMs) {
          minExpiresAtMs = rowExp;
        }
      }
      for (const row of revocationsRes.rows) {
        const rowExp = new Date(row.expires_at).getTime();
        if (rowExp < minExpiresAtMs) {
          minExpiresAtMs = rowExp;
        }
      }

      const cached: CachedState = {
        etag,
        registryVersion,
        activeLeases,
        revocations,
        keyRevocations,
        expiresAtMs: Math.max(minExpiresAtMs, Date.now() + 1000),
        fetchedAtMs: Date.now(),
      };

      this.cache.set(env, cached);
      return cached;
    } finally {
      client.release();
    }
  }

  /**
   * Builds the external HTTP JSON delivery payload from cached state.
   */
  formatPayload(state: CachedState): StateDeliveryPayload {
    return {
      etag: state.etag,
      server_time: new Date().toISOString(),
      registry_version: state.registryVersion,
      active_leases: state.activeLeases,
      revocations: state.revocations,
      key_revocations: state.keyRevocations,
    };
  }

  /**
   * Broadcasts state mutation to waking active long-polling connections.
   */
  async notifyChange(env?: string): Promise<void> {
    if (env) {
      this.cache.delete(env);
      const newState = await this.getState(env, true);
      const envWaiters = this.waiters.get(env);
      if (envWaiters && envWaiters.size > 0) {
        const listeners = Array.from(envWaiters);
        envWaiters.clear();
        for (const listener of listeners) {
          try {
            listener(newState);
          } catch (err) {
            console.error("[StateManager] Error dispatching waiter callback:", err);
          }
        }
      }
    } else {
      // Invalidate all environments
      this.cache.clear();
      for (const [waitEnv, envWaiters] of this.waiters.entries()) {
        if (envWaiters.size > 0) {
          const newState = await this.getState(waitEnv, true);
          const listeners = Array.from(envWaiters);
          envWaiters.clear();
          for (const listener of listeners) {
            try {
              listener(newState);
            } catch (err) {
              console.error("[StateManager] Error dispatching waiter callback:", err);
            }
          }
        }
      }
    }
  }

  /**
   * Coordinates long-polling suspension and wake-up.
   *
   * @param env Environment identifier
   * @param clientEtag Optional client If-None-Match header
   * @param waitSeconds Long-poll wait duration in seconds (0 for immediate poll, max 60s)
   * @param signal Optional AbortSignal from request disconnect
   */
  async waitForChange(
    env: string,
    clientEtag?: string | null,
    waitSeconds = 0,
    signal?: AbortSignal
  ): Promise<{ status: 200; state: CachedState } | { status: 304; state: CachedState }> {
    const currentState = await this.getState(env);
    const cleanClient = normalizeEtag(clientEtag);
    const cleanCurrent = normalizeEtag(currentState.etag);

    // If client has no ETag or has an outdated ETag -> Immediate HTTP 200
    if (!cleanClient || cleanClient !== cleanCurrent) {
      return { status: 200, state: currentState };
    }

    // Client has matching ETag and requested no wait -> Immediate HTTP 304
    const clampedWait = Math.min(Math.max(waitSeconds, 0), 60);
    if (clampedWait === 0) {
      return { status: 304, state: currentState };
    }

    // Long-polling suspension: hold connection until update or timeout
    return new Promise((resolve) => {
      let timeoutId: NodeJS.Timeout | undefined;
      let settled = false;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        const set = this.waiters.get(env);
        if (set) {
          set.delete(onUpdate);
        }
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      };

      const onUpdate = (newState: CachedState) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ status: 200, state: newState });
      };

      const onTimeout = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ status: 304, state: currentState });
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ status: 304, state: currentState });
      };

      if (signal?.aborted) {
        return resolve({ status: 304, state: currentState });
      }

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      let envWaiters = this.waiters.get(env);
      if (!envWaiters) {
        envWaiters = new Set();
        this.waiters.set(env, envWaiters);
      }
      envWaiters.add(onUpdate);

      timeoutId = setTimeout(onTimeout, clampedWait * 1000);
      if (timeoutId.unref) {
        timeoutId.unref();
      }
    });
  }

  /**
   * Returns count of suspended long-poll connections waiting on an environment.
   */
  getWaiterCount(env: string): number {
    return this.waiters.get(env)?.size ?? 0;
  }
}
