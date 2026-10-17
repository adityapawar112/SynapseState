import { describe, it, expect, vi } from "vitest";
import {
  buildQuiescenceRollupQuery,
  mapRowToFlagTelemetrySnapshot,
  fetchFlagTelemetrySnapshots,
} from "./queries.js";
import type { Queryable, RawRollupRow } from "./types.js";

describe("Purger Quiescence SQL Rollup Engine", () => {
  describe("buildQuiescenceRollupQuery", () => {
    it("generates parameterized SQL with default options (35 days window)", () => {
      const query = buildQuiescenceRollupQuery();

      expect(query.text).toBeDefined();
      expect(query.values).toEqual([35, null, null]);

      // Verify date math and interval logic
      expect(query.text).toMatch(/make_interval\(days => \$1::int\)/i);
      expect(query.text).toMatch(/flag_usage_daily/);
      expect(query.text).toMatch(/services/);
      expect(query.text).toMatch(/flags/);
      expect(query.text).toMatch(/leases/);
      expect(query.text).toMatch(/state = 'ACTIVE'/);
      expect(query.text).toMatch(/expires_at > NOW\(\)/);
    });

    it("binds custom windowDays, env, and flagKey parameters", () => {
      const query = buildQuiescenceRollupQuery({
        windowDays: 45,
        env: "staging",
        flagKey: "new-search-algorithm",
      });

      expect(query.values).toEqual([45, "staging", "new-search-algorithm"]);
      expect(query.text).toContain("$1");
      expect(query.text).toContain("$2");
      expect(query.text).toContain("$3");
    });

    it("verifies service status fallback to SILENT for unregistered consumers", () => {
      const query = buildQuiescenceRollupQuery();

      // If a service evaluated a flag in flag_usage_daily but was never heartbeated/registered,
      // it must default to SILENT to block unsafe purges.
      expect(query.text).toMatch(
        /COALESCE\s*\(\s*s\.status\s*,\s*'SILENT'\s*\)/i,
      );
    });

    it("quotes reserved columns 'key' and 'class' in queries", () => {
      const query = buildQuiescenceRollupQuery();

      expect(query.text).toMatch(/f\."class"/);
      expect(query.text).toMatch(/f\."key"/);
    });
  });

  describe("mapRowToFlagTelemetrySnapshot", () => {
    const sampleRawRow: RawRollupRow = {
      flag_key: "payment-retry-logic",
      env: "production",
      flag_class: "release",
      flag_created_at: "2026-08-01T00:00:00.000Z",
      has_active_lease: false,
      variants: [
        {
          variant: "exponential",
          evalCount: "125000",
          firstSeen: "2026-09-01T12:00:00.000Z",
          lastSeen: "2026-10-06T15:30:00.000Z", // 35-day span
        },
      ],
      services: [
        {
          serviceName: "checkout-api",
          status: "ACTIVE",
          evalCount: "125000",
          lastSeen: "2026-10-06T15:30:00.000Z",
        },
      ],
    };

    it("maps raw Postgres row with string evalCounts into typed FlagTelemetrySnapshot", () => {
      const snapshot = mapRowToFlagTelemetrySnapshot(sampleRawRow, 35);

      expect(snapshot).toEqual({
        flagKey: "payment-retry-logic",
        env: "production",
        flagClass: "release",
        hasActiveLease: false,
        windowDays: 35,
        firstSeen: "2026-09-01T12:00:00.000Z",
        lastSeen: "2026-10-06T15:30:00.000Z",
        variants: [
          {
            variant: "exponential",
            evalCount: 125000,
            firstSeen: "2026-09-01T12:00:00.000Z",
            lastSeen: "2026-10-06T15:30:00.000Z",
          },
        ],
        services: [
          {
            serviceName: "checkout-api",
            status: "ACTIVE",
            evalCount: 125000,
            lastSeen: "2026-10-06T15:30:00.000Z",
          },
        ],
      });
    });

    it("derives effective windowDays from actual telemetry firstSeen/lastSeen span (C1)", () => {
      const shortSpanRow: RawRollupRow = {
        ...sampleRawRow,
        variants: [
          {
            variant: "exponential",
            evalCount: "1000",
            firstSeen: "2026-10-04T00:00:00.000Z",
            lastSeen: "2026-10-06T00:00:00.000Z", // 2 days span
          },
        ],
      };

      // Even if caller requested 35 days, effectiveWindowDays must be capped at actual 2 days
      const snapshot = mapRowToFlagTelemetrySnapshot(shortSpanRow, 35);
      expect(snapshot.windowDays).toBe(2);
    });

    it("derives effective windowDays from flag_created_at age when 0 evaluations recorded (C1)", () => {
      const recentFlagRow: RawRollupRow = {
        flag_key: "brand-new-flag",
        env: "production",
        flag_class: "release",
        flag_created_at: new Date(Date.now() - 3 * 86400 * 1000).toISOString(), // created 3 days ago
        has_active_lease: false,
        variants: [],
        services: [],
      };

      const snapshot = mapRowToFlagTelemetrySnapshot(recentFlagRow, 35);
      expect(snapshot.windowDays).toBe(3);
    });

    it("safely handles invalid date strings without throwing RangeError (I4)", () => {
      const invalidDateRow: RawRollupRow = {
        ...sampleRawRow,
        variants: [
          {
            variant: "test",
            evalCount: "10",
            firstSeen: "not-a-valid-date",
            lastSeen: "invalid-time",
          },
        ],
      };

      // Must not throw RangeError
      expect(() =>
        mapRowToFlagTelemetrySnapshot(invalidDateRow, 35),
      ).not.toThrow();
      const snapshot = mapRowToFlagTelemetrySnapshot(invalidDateRow, 35);
      expect(snapshot.firstSeen).toBeUndefined();
      expect(snapshot.lastSeen).toBeUndefined();
    });

    it("handles null flag_class as undefined (unregistered flag)", () => {
      const rawRow: RawRollupRow = {
        ...sampleRawRow,
        flag_class: null,
      };

      const snapshot = mapRowToFlagTelemetrySnapshot(rawRow, 35);
      expect(snapshot.flagClass).toBeUndefined();
    });

    it("handles empty or null JSON variant and service arrays gracefully", () => {
      const rawRow: RawRollupRow = {
        ...sampleRawRow,
        flag_created_at: null,
        variants: null as unknown as RawRollupRow["variants"],
        services: null as unknown as RawRollupRow["services"],
      };

      const snapshot = mapRowToFlagTelemetrySnapshot(rawRow, 35);
      expect(snapshot.variants).toEqual([]);
      expect(snapshot.services).toEqual([]);
      expect(snapshot.firstSeen).toBeUndefined();
      expect(snapshot.lastSeen).toBeUndefined();
    });

    it("correctly identifies earliest firstSeen and latest lastSeen across variants", () => {
      const rawRow: RawRollupRow = {
        ...sampleRawRow,
        variants: [
          {
            variant: "varA",
            evalCount: 50,
            firstSeen: "2026-09-05T00:00:00.000Z",
            lastSeen: "2026-09-20T00:00:00.000Z",
          },
          {
            variant: "varB",
            evalCount: 150,
            firstSeen: "2026-09-01T00:00:00.000Z",
            lastSeen: "2026-10-05T00:00:00.000Z",
          },
        ],
      };

      const snapshot = mapRowToFlagTelemetrySnapshot(rawRow, 35);
      expect(snapshot.firstSeen).toBe("2026-09-01T00:00:00.000Z");
      expect(snapshot.lastSeen).toBe("2026-10-05T00:00:00.000Z");
    });
  });

  describe("fetchFlagTelemetrySnapshots", () => {
    it("executes query and returns mapped snapshots", async () => {
      const mockRawRows: RawRollupRow[] = [
        {
          flag_key: "flag-1",
          env: "production",
          flag_class: "release",
          flag_created_at: "2026-08-01T00:00:00.000Z",
          has_active_lease: false,
          variants: [{ variant: "on", evalCount: "100" }],
          services: [{ serviceName: "api", status: "ACTIVE" }],
        },
      ];

      const mockQuery = vi.fn().mockResolvedValue({ rows: mockRawRows });
      const mockDb: Queryable = { query: mockQuery };

      const snapshots = await fetchFlagTelemetrySnapshots(mockDb, {
        windowDays: 35,
        env: "production",
      });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("flag_usage_daily");
      expect(params).toEqual([35, "production", null]);

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].flagKey).toBe("flag-1");
      expect(snapshots[0].variants[0].evalCount).toBe(100);
    });
  });
});
