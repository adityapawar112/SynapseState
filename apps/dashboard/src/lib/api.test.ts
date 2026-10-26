import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ControlApiClient } from "@/lib/api";

describe("Dashboard Control API Client", () => {
  const mockApiUrl = "http://control-api.internal:3000";
  const mockToken = "synapse-test-token";

  let client: ControlApiClient;

  beforeEach(() => {
    client = new ControlApiClient({
      baseUrl: mockApiUrl,
      apiToken: mockToken,
    });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchActiveLeases", () => {
    it("fetches state and transforms active leases into ActiveLeaseView list", async () => {
      const mockStatePayload = {
        etag: "abc123etag",
        server_time: "2026-10-18T00:00:00.000Z",
        registry_version: 1,
        active_leases: [
          {
            payload: {
              lease_id: "01J9X57YTRPQ8A7F4E12345678",
              flag_key: "killswitch-checkout",
              env: "prod",
              value: true,
              reason: "Incident #101",
              issued_at: "2026-10-18T00:00:00.000Z",
              ttl_seconds: 1800,
              kid: "ops-key-1",
            },
            sig: "mock-sig",
          },
        ],
        revocations: [],
        key_revocations: [],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockStatePayload,
      } as Response);

      const leases = await client.fetchActiveLeases("prod");

      expect(fetch).toHaveBeenCalledWith(
        "http://control-api.internal:3000/v1/sdk/state?env=prod&wait=0",
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: "application/json",
          }),
        }),
      );
      expect(leases).toHaveLength(1);
      expect(leases[0].leaseId).toBe("01J9X57YTRPQ8A7F4E12345678");
      expect(leases[0].flagKey).toBe("killswitch-checkout");
      expect(leases[0].status).toBe("ACTIVE");
    });

    it("returns empty list if fetch fails or network is down", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Connection refused"),
      );

      const leases = await client.fetchActiveLeases("prod");
      expect(leases).toEqual([]);
    });
  });

  describe("fetchAuditEvents", () => {
    it("calls /v1/audit/events with Bearer authorization and transforms records", async () => {
      const mockAuditResponse = {
        events: [
          {
            seq: 1,
            ts: "2026-10-18T00:00:00.000Z",
            actor: "ops-key-1",
            event_type: "LEASE_CREATED",
            payload: { lease_id: "01J9X" },
            prev_hash:
              "0000000000000000000000000000000000000000000000000000000000000000",
            hash: "hash-1",
          },
        ],
        count: 1,
        total: 1,
        has_more: false,
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockAuditResponse,
      } as Response);

      const result = await client.fetchAuditEvents({ fromSeq: 1, limit: 50 });

      expect(fetch).toHaveBeenCalledWith(
        "http://control-api.internal:3000/v1/audit/events?from_seq=1&limit=50",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer synapse-test-token",
          }),
        }),
      );
      expect(result.events).toHaveLength(1);
      expect(result.events[0].seq).toBe(1);
      expect(result.events[0].eventType).toBe("LEASE_CREATED");
      expect(result.total).toBe(1);
    });
  });

  describe("fetchFlagInventory", () => {
    it("aggregates telemetry changes and state into FlagInventoryView items", async () => {
      const mockChangesResponse = {
        query: { env: "prod" },
        events: [],
        evaluations: [
          { flag_key: "feature-new-ui", variant: "treatment", eval_count: 990 },
          { flag_key: "feature-new-ui", variant: "control", eval_count: 10 },
          { flag_key: "search-algo", variant: "v2", eval_count: 500 },
        ],
      };

      const mockStateResponse = {
        etag: "etag",
        server_time: "2026-10-18T00:00:00.000Z",
        registry_version: 1,
        active_leases: [],
        revocations: [],
        key_revocations: [],
      };

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockChangesResponse,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockStateResponse,
        } as Response);

      const inventory = await client.fetchFlagInventory("prod");

      expect(inventory).toHaveLength(2);
      const newUiFlag = inventory.find((f) => f.flagKey === "feature-new-ui");
      expect(newUiFlag).toBeDefined();
      expect(newUiFlag?.totalEvaluations).toBe(1000);
      expect(newUiFlag?.isQuiescent).toBe(true);
      expect(newUiFlag?.winningVariant).toBe("treatment");
      expect(newUiFlag?.isCandidateForPurge).toBe(true);
    });
  });

  describe("fetchDashboardOverview", () => {
    it("assembles complete overview metrics from state, changes, and audit checkpoint", async () => {
      const mockStateResponse = {
        etag: "etag123",
        server_time: "2026-10-18T01:00:00.000Z",
        registry_version: 2,
        active_leases: [],
        revocations: [],
        key_revocations: [],
      };

      const mockChangesResponse = {
        query: { env: "prod" },
        events: [],
        evaluations: [{ flag_key: "flag1", variant: "v1", eval_count: 1200 }],
      };

      const mockCheckpointResponse = {
        checkpoint_seq: 42,
        checkpoint_hash: "hash-42",
        sealed_count: 42,
        timestamp: "2026-10-18T00:55:00.000Z",
      };

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockStateResponse,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockChangesResponse,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockCheckpointResponse,
        } as Response);

      const overview = await client.fetchDashboardOverview("prod");

      expect(overview.controlApiStatus).toBe("healthy");
      expect(overview.selectedEnv).toBe("prod");
      expect(overview.totalEvaluations24h).toBe(1200);
      expect(overview.sealedAuditCount).toBe(42);
      expect(overview.latestCheckpointSeq).toBe(42);
    });
  });

  describe("revokeLease", () => {
    it("sends signed revocation envelope to POST /v1/leases/:id/revoke", async () => {
      const revocationEnvelope = {
        payload: {
          v: 1 as const,
          lease_id: "01J9X57YTRPQ8A7F4E12345678",
          reason: "Incident resolved",
          revoked_at: "2026-10-18T01:30:00.000Z",
          kid: "ops-key-1",
        },
        sig: "valid-sig",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          lease_id: "01J9X57YTRPQ8A7F4E12345678",
          state: "REVOKED",
        }),
      } as Response);

      const result = await client.revokeLease(
        "01J9X57YTRPQ8A7F4E12345678",
        revocationEnvelope,
      );

      expect(fetch).toHaveBeenCalledWith(
        "http://control-api.internal:3000/v1/leases/01J9X57YTRPQ8A7F4E12345678/revoke",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(revocationEnvelope),
        }),
      );
      expect(result.state).toBe("REVOKED");
    });
  });

  describe("promoteLease (PR 25)", () => {
    it("calls POST /v1/leases/:id/promote and returns promotion result", async () => {
      const mockResult = {
        lease_id: "01J9X57YTRPQ8A7F4E12345678",
        pr_url: "https://github.com/adityapawar112/SynapseState/pull/25",
        branch: "synapse/promote-lease-01J9X57YTRPQ8A7F4E12345678",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => mockResult,
      } as Response);

      const result = await client.promoteLease("01J9X57YTRPQ8A7F4E12345678", {
        env: "prod",
      });

      expect(fetch).toHaveBeenCalledWith(
        "http://control-api.internal:3000/v1/leases/01J9X57YTRPQ8A7F4E12345678/promote",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer synapse-test-token",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ env: "prod" }),
        }),
      );
      expect(result.pr_url).toBe(mockResult.pr_url);
      expect(result.branch).toBe(mockResult.branch);
    });

    it("throws descriptive error when promote API returns an error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: "Conflict",
        json: async () => ({
          error: "STALE_PR_CONFLICT",
          message: "Conflict with existing PR",
          existing_pr_url:
            "https://github.com/adityapawar112/SynapseState/pull/20",
        }),
      } as Response);

      await expect(
        client.promoteLease("01J9X57YTRPQ8A7F4E12345678"),
      ).rejects.toThrow("Conflict with existing PR");
    });
  });

  describe("recordAuditEvent (PR 25)", () => {
    it("posts staged audit event to /v1/audit/events", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ status: "staged" }),
      } as Response);

      const success = await client.recordAuditEvent({
        actor: "sre-alice",
        eventType: "DASHBOARD_LOGIN",
        payload: { role: "operator" },
      });

      expect(fetch).toHaveBeenCalledWith(
        "http://control-api.internal:3000/v1/audit/events",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer synapse-test-token",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            actor: "sre-alice",
            event_type: "DASHBOARD_LOGIN",
            payload: { role: "operator" },
          }),
        }),
      );
      expect(success).toBe(true);
    });

    it("returns false gracefully if recording audit event fails or times out", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Network timeout"),
      );

      const success = await client.recordAuditEvent({
        actor: "sre-alice",
        eventType: "DASHBOARD_LOGIN",
      });

      expect(success).toBe(false);
    });
  });
});
