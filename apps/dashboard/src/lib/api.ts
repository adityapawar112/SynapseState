import type {
  ActiveLeaseView,
  AuditCheckpointView,
  AuditLedgerRecord,
  DashboardOverview,
  FlagInventoryView,
} from "@/lib/types";
import {
  calculateLeaseExpiryView,
  calculateVariantDistribution,
  evaluateFlagQuiescence,
} from "@/lib/domain";
import type { LeaseEnvelope, RevocationEnvelope } from "@synapsestate/lease";

export interface ControlApiClientOptions {
  baseUrl?: string;
  apiToken?: string;
  timeoutMs?: number;
}

export interface AuditEventsQueryOptions {
  fromSeq?: number;
  toSeq?: number;
  limit?: number;
}

export interface AuditEventsResponse {
  events: AuditLedgerRecord[];
  total: number;
  hasMore: boolean;
}

export class ControlApiClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;

  constructor(options: ControlApiClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ||
      process.env.CONTROL_API_URL ||
      process.env.NEXT_PUBLIC_CONTROL_API_URL ||
      "http://localhost:3000"
    ).replace(/\/$/, "");

    this.apiToken =
      options.apiToken ||
      process.env.CONTROL_API_TOKEN ||
      process.env.SYNAPSE_API_TOKEN ||
      "";

    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  private async fetchJson<T>(
    endpoint: string,
    init: RequestInit = {}
  ): Promise<T | null> {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init.headers as Record<string, string>),
    };

    if (this.apiToken && !headers["Authorization"]) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        return null;
      }

      return (await res.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fetches active emergency leases from GET /v1/sdk/state
   */
  async fetchActiveLeases(env: string = "prod"): Promise<ActiveLeaseView[]> {
    interface StateDeliveryPayload {
      etag: string;
      server_time: string;
      registry_version: number;
      active_leases: LeaseEnvelope[];
    }

    const data = await this.fetchJson<StateDeliveryPayload>(
      `/v1/sdk/state?env=${encodeURIComponent(env)}&wait=0`
    );

    if (!data || !Array.isArray(data.active_leases)) {
      return [];
    }

    const referenceTime = data.server_time ? new Date(data.server_time) : new Date();
    return data.active_leases.map((env) =>
      calculateLeaseExpiryView(env, referenceTime)
    );
  }

  /**
   * Fetches audit trail events from GET /v1/audit/events
   */
  async fetchAuditEvents(
    options: AuditEventsQueryOptions = {}
  ): Promise<AuditEventsResponse> {
    const params = new URLSearchParams();
    if (options.fromSeq !== undefined) params.set("from_seq", String(options.fromSeq));
    if (options.toSeq !== undefined) params.set("to_seq", String(options.toSeq));
    if (options.limit !== undefined) params.set("limit", String(options.limit));

    interface RawAuditRecord {
      seq: number;
      ts?: string;
      timestamp?: string;
      actor?: string;
      actorKid?: string;
      event_type?: string;
      eventType?: string;
      payload?: Record<string, unknown>;
      prev_hash?: string;
      prevHash?: string;
      hash?: string;
      eventHash?: string;
    }

    interface RawAuditResponse {
      events: RawAuditRecord[];
      total: number;
      sealed_total?: number;
      has_more: boolean;
    }

    const data = await this.fetchJson<RawAuditResponse>(
      `/v1/audit/events?${params.toString()}`
    );

    if (!data || !Array.isArray(data.events)) {
      return { events: [], total: 0, hasMore: false };
    }

    const events: AuditLedgerRecord[] = data.events.map((r: RawAuditRecord) => ({
      seq: r.seq,
      ts: r.ts || r.timestamp || new Date().toISOString(),
      actor: r.actor || r.actorKid || "unknown",
      eventType: r.event_type || r.eventType || "AUDIT_RECORD",
      payload: r.payload || {},
      prevHash: r.prev_hash || r.prevHash || "",
      hash: r.hash || r.eventHash || "",
    }));

    return {
      events,
      total: data.total ?? data.sealed_total ?? events.length,
      hasMore: Boolean(data.has_more),
    };
  }

  /**
   * Fetches latest sealed checkpoint from GET /v1/audit/checkpoint/latest
   */
  async fetchLatestCheckpoint(): Promise<AuditCheckpointView> {
    interface RawCheckpoint {
      checkpoint_seq: number;
      checkpoint_hash: string;
      sealed_count: number;
      timestamp: string | null;
    }

    const data = await this.fetchJson<RawCheckpoint>("/v1/audit/checkpoint/latest");

    if (!data) {
      return {
        checkpointSeq: 0,
        checkpointHash: "genesis",
        sealedCount: 0,
        timestamp: null,
      };
    }

    const raw = data as unknown as Record<string, unknown>;
    return {
      checkpointSeq: Number(data.checkpoint_seq ?? raw.checkpointSeq ?? 0),
      checkpointHash: String(data.checkpoint_hash ?? raw.checkpointHash ?? "genesis"),
      sealedCount: Number(data.sealed_count ?? raw.sealedCount ?? 0),
      timestamp: data.timestamp ?? (raw.timestamp as string | null) ?? null,
    };
  }

  /**
   * Fetches flag inventory, variant rollups, and candidate status from GET /v1/changes
   */
  async fetchFlagInventory(env: string = "prod"): Promise<FlagInventoryView[]> {
    interface RawChangesResponse {
      query: { env: string };
      events: unknown[];
      evaluations: Array<{
        flag_key: string;
        variant: string;
        eval_count: number;
      }>;
    }

    const [changes, activeLeases] = await Promise.all([
      this.fetchJson<RawChangesResponse>(
        `/v1/changes?env=${encodeURIComponent(env)}&since=30d&limit=200`
      ),
      this.fetchActiveLeases(env),
    ]);

    const leasesByFlag = new Map<string, ActiveLeaseView>();
    for (const l of activeLeases) {
      leasesByFlag.set(l.flagKey, l);
    }

    // Aggregate by flag_key
    const flagsMap = new Map<string, Map<string, number>>();

    if (changes && Array.isArray(changes.evaluations)) {
      for (const item of changes.evaluations) {
        if (!flagsMap.has(item.flag_key)) {
          flagsMap.set(item.flag_key, new Map());
        }
        const variants = flagsMap.get(item.flag_key)!;
        variants.set(
          item.variant,
          (variants.get(item.variant) || 0) + item.eval_count
        );
      }
    }

    // Also include any active leases even if 0 evaluations exist yet
    for (const lease of activeLeases) {
      if (!flagsMap.has(lease.flagKey)) {
        flagsMap.set(lease.flagKey, new Map([[String(lease.value), 0]]));
      }
    }

    const results: FlagInventoryView[] = [];

    for (const [flagKey, variantsMap] of flagsMap.entries()) {
      const variantCounts = Array.from(variantsMap.entries()).map(([variant, count]) => ({
        variant,
        count,
      }));

      const totalEvaluations = variantCounts.reduce((acc, c) => acc + c.count, 0);
      const variants = calculateVariantDistribution(variantCounts);
      const quiescence = evaluateFlagQuiescence(variants, totalEvaluations);

      results.push({
        flagKey,
        env,
        totalEvaluations,
        variants,
        activeLease: leasesByFlag.get(flagKey),
        isQuiescent: quiescence.isQuiescent,
        winningVariant: quiescence.winningVariant,
        isCandidateForPurge: quiescence.isCandidateForPurge,
        services: [],
      });
    }

    return results.sort((a, b) => b.totalEvaluations - a.totalEvaluations);
  }

  /**
   * Compiles the full dashboard overview for the header and landing page
   */
  async fetchDashboardOverview(env: string = "prod"): Promise<DashboardOverview> {
    const [stateRes, changesRes, checkpoint] = await Promise.all([
      this.fetchJson<{ server_time?: string; active_leases?: LeaseEnvelope[] }>(
        `/v1/sdk/state?env=${encodeURIComponent(env)}&wait=0`
      ),
      this.fetchJson<{
        evaluations?: Array<{ flag_key: string; eval_count: number }>;
      }>(`/v1/changes?env=${encodeURIComponent(env)}&since=24h`),
      this.fetchLatestCheckpoint(),
    ]);

    const isHealthy = stateRes !== null;
    const serverTime = stateRes?.server_time || new Date().toISOString();
    const activeLeases = (stateRes?.active_leases || []).map((env) =>
      calculateLeaseExpiryView(env, new Date(serverTime))
    );

    const totalEvaluations24h = (changesRes?.evaluations || []).reduce(
      (acc, e) => acc + (e.eval_count || 0),
      0
    );

    const uniqueFlags = new Set<string>();
    (changesRes?.evaluations || []).forEach((e) => uniqueFlags.add(e.flag_key));
    activeLeases.forEach((l) => uniqueFlags.add(l.flagKey));

    return {
      serverTime,
      activeLeasesCount: activeLeases.length,
      activeLeases,
      totalFlagsCount: uniqueFlags.size,
      totalEvaluations24h,
      sealedAuditCount: checkpoint.sealedCount,
      latestCheckpointHash: checkpoint.checkpointHash,
      latestCheckpointSeq: checkpoint.checkpointSeq,
      controlApiStatus: isHealthy ? "healthy" : "unreachable",
      environments: ["prod", "staging", "dev"],
      selectedEnv: env,
    };
  }

  /**
   * Posts an authorized RevocationEnvelope to terminate an active lease
   */
  async revokeLease(
    leaseId: string,
    envelope: RevocationEnvelope
  ): Promise<{ lease_id: string; state: string }> {
    const url = `${this.baseUrl}/v1/leases/${encodeURIComponent(leaseId)}/revoke`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
      },
      body: JSON.stringify(envelope),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Revocation request failed" }));
      throw new Error(err.error || `Failed to revoke lease: ${res.statusText}`);
    }

    return (await res.json()) as { lease_id: string; state: string };
  }
}

/**
 * Singleton client instance for Server Components and route handlers
 */
export const controlApiClient = new ControlApiClient();
