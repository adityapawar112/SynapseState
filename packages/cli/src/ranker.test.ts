import { describe, it, expect } from "vitest";
import {
  rankSuspects,
  type ChangeEvent,
  type FlagEvaluationRecord,
} from "./ranker.js";

describe("Incident Attribution Ranker (packages/cli/src/ranker.ts)", () => {
  const FIXED_NOW = new Date("2026-10-16T12:00:00.000Z").getTime();

  it("returns empty array when no events are provided", () => {
    const suspects = rankSuspects([], [], "checkout-service", FIXED_NOW);
    expect(suspects).toEqual([]);
  });

  it("filters out events with null or empty flag_key", () => {
    const events: ChangeEvent[] = [
      {
        id: 1,
        event_type: "GIT_MERGE",
        env: "production",
        flag_key: null,
        actor: "sre-alice",
        occurred_at: "2026-10-16T11:55:00.000Z",
        payload: {},
      },
      {
        id: 2,
        event_type: "GIT_MERGE",
        env: "production",
        flag_key: "",
        actor: "sre-bob",
        occurred_at: "2026-10-16T11:56:00.000Z",
        payload: {},
      },
    ];

    const suspects = rankSuspects(events, [], "checkout-service", FIXED_NOW);
    expect(suspects).toEqual([]);
  });

  it("ranks recent events higher than older events (recency decay)", () => {
    const events: ChangeEvent[] = [
      {
        id: 101,
        event_type: "LEASE_CREATED",
        env: "production",
        flag_key: "flag-older",
        actor: "sre-alice",
        occurred_at: new Date(FIXED_NOW - 45 * 60 * 1000).toISOString(), // 45m ago
        payload: { value: true },
      },
      {
        id: 102,
        event_type: "LEASE_CREATED",
        env: "production",
        flag_key: "flag-recent",
        actor: "sre-bob",
        occurred_at: new Date(FIXED_NOW - 2 * 60 * 1000).toISOString(), // 2m ago
        payload: { value: true },
      },
    ];

    const suspects = rankSuspects(events, [], "checkout-service", FIXED_NOW);
    expect(suspects).toHaveLength(2);
    expect(suspects[0].flag_key).toBe("flag-recent");
    expect(suspects[1].flag_key).toBe("flag-older");
    expect(suspects[0].recency_score).toBeGreaterThan(suspects[1].recency_score);
    expect(suspects[0].score).toBeGreaterThan(suspects[1].score);
  });

  it("weights high-volume flags in targetService above idle flags", () => {
    // Both events occurred 5 minutes ago with the same event type
    const occurredAt = new Date(FIXED_NOW - 5 * 60 * 1000).toISOString();
    const events: ChangeEvent[] = [
      {
        id: 201,
        event_type: "LEASE_CREATED",
        env: "production",
        flag_key: "flag-idle",
        actor: "sre-alice",
        occurred_at: occurredAt,
        payload: { value: true },
      },
      {
        id: 202,
        event_type: "LEASE_CREATED",
        env: "production",
        flag_key: "flag-active",
        actor: "sre-bob",
        occurred_at: occurredAt,
        payload: { value: true },
      },
    ];

    const evaluations: FlagEvaluationRecord[] = [
      { flag_key: "flag-active", variant: "true", eval_count: 50000 },
      { flag_key: "flag-idle", variant: "false", eval_count: 0 },
    ];

    const suspects = rankSuspects(events, evaluations, "checkout-service", FIXED_NOW);
    expect(suspects).toHaveLength(2);
    expect(suspects[0].flag_key).toBe("flag-active");
    expect(suspects[0].volume_score).toBe(100);
    expect(suspects[0].eval_count).toBe(50000);
    expect(suspects[1].flag_key).toBe("flag-idle");
    expect(suspects[1].volume_score).toBe(0);
    expect(suspects[1].eval_count).toBe(0);
    expect(suspects[0].score).toBeGreaterThan(suspects[1].score);
  });

  it("ranks active modifications higher than passive expirations", () => {
    const occurredAt = new Date(FIXED_NOW - 5 * 60 * 1000).toISOString();
    const events: ChangeEvent[] = [
      {
        id: 301,
        event_type: "LEASE_EXPIRED",
        env: "production",
        flag_key: "flag-expired",
        actor: "system",
        occurred_at: occurredAt,
        payload: {},
      },
      {
        id: 302,
        event_type: "LEASE_CREATED",
        env: "production",
        flag_key: "flag-created",
        actor: "sre-alice",
        occurred_at: occurredAt,
        payload: { value: true },
      },
    ];

    const suspects = rankSuspects(events, [], "checkout-service", FIXED_NOW);
    expect(suspects).toHaveLength(2);
    expect(suspects[0].flag_key).toBe("flag-created");
    expect(suspects[1].flag_key).toBe("flag-expired");
    expect(suspects[0].score).toBeGreaterThan(suspects[1].score);
  });

  it("breaks ties deterministically by occurred_at DESC, then flag_key ASC", () => {
    const events: ChangeEvent[] = [
      {
        id: 401,
        event_type: "LEASE_CREATED",
        env: "production",
        flag_key: "zebra-flag",
        actor: "sre",
        occurred_at: new Date(FIXED_NOW - 1000).toISOString(),
        payload: {},
      },
      {
        id: 402,
        event_type: "LEASE_CREATED",
        env: "production",
        flag_key: "alpha-flag",
        actor: "sre",
        occurred_at: new Date(FIXED_NOW - 1000).toISOString(),
        payload: {},
      },
    ];

    const suspects = rankSuspects(events, [], "checkout-service", FIXED_NOW);
    expect(suspects).toHaveLength(2);
    expect(suspects[0].flag_key).toBe("alpha-flag");
    expect(suspects[1].flag_key).toBe("zebra-flag");
  });

  describe("Type-Aware Suggested Action Generation", () => {
    it("suggests false when previous value was true", () => {
      const events: ChangeEvent[] = [
        {
          id: 501,
          event_type: "LEASE_CREATED",
          env: "production",
          flag_key: "checkout-v2",
          actor: "sre-alice",
          occurred_at: new Date(FIXED_NOW - 60000).toISOString(),
          payload: { value: true },
        },
      ];

      const [suspect] = rankSuspects(events, [], "checkout-service", FIXED_NOW);
      expect(suspect.suggested_action.suggested_value).toBe(false);
      expect(suspect.suggested_action.command).toContain(
        "synapse lease create --flag checkout-v2 --env production --value false --ttl 30m",
      );
      expect(suspect.current_variant).toBe("true");
    });

    it("suggests true when previous value was false", () => {
      const events: ChangeEvent[] = [
        {
          id: 502,
          event_type: "LEASE_CREATED",
          env: "staging",
          flag_key: "strict-auth",
          actor: "sre-bob",
          occurred_at: new Date(FIXED_NOW - 60000).toISOString(),
          payload: { value: false },
        },
      ];

      const [suspect] = rankSuspects(events, [], "auth-service", FIXED_NOW);
      expect(suspect.suggested_action.suggested_value).toBe(true);
      expect(suspect.suggested_action.command).toContain(
        "synapse lease create --flag strict-auth --env staging --value true --ttl 30m",
      );
      expect(suspect.current_variant).toBe("false");
    });

    it("suggests off when previous value was on (and vice-versa)", () => {
      const events: ChangeEvent[] = [
        {
          id: 503,
          event_type: "LEASE_CREATED",
          env: "production",
          flag_key: "rate-limiter",
          actor: "sre-alice",
          occurred_at: new Date(FIXED_NOW - 60000).toISOString(),
          payload: { value: "on" },
        },
      ];

      const [suspect] = rankSuspects(events, [], "api-gateway", FIXED_NOW);
      expect(suspect.suggested_action.suggested_value).toBe("off");
      expect(suspect.current_variant).toBe("on");
    });

    it("suggests 0 when previous value was 1", () => {
      const events: ChangeEvent[] = [
        {
          id: 504,
          event_type: "LEASE_CREATED",
          env: "production",
          flag_key: "max-concurrency-tier",
          actor: "sre-alice",
          occurred_at: new Date(FIXED_NOW - 60000).toISOString(),
          payload: { value: 1 },
        },
      ];

      const [suspect] = rankSuspects(events, [], "worker-pool", FIXED_NOW);
      expect(suspect.suggested_action.suggested_value).toBe(0);
      expect(suspect.current_variant).toBe("1");
    });

    it("suggests historical baseline/control variant for multi-variant canary flag", () => {
      const events: ChangeEvent[] = [
        {
          id: 505,
          event_type: "LEASE_CREATED",
          env: "production",
          flag_key: "search-algorithm",
          actor: "sre-alice",
          occurred_at: new Date(FIXED_NOW - 60000).toISOString(),
          payload: { value: "canary-ml" },
        },
      ];

      const evaluations: FlagEvaluationRecord[] = [
        { flag_key: "search-algorithm", variant: "canary-ml", eval_count: 5000 },
        { flag_key: "search-algorithm", variant: "control", eval_count: 45000 },
        { flag_key: "search-algorithm", variant: "experimental-v2", eval_count: 1000 },
      ];

      const [suspect] = rankSuspects(events, evaluations, "search-service", FIXED_NOW);
      expect(suspect.suggested_action.suggested_value).toBe("control");
      expect(suspect.current_variant).toBe("canary-ml");
      expect(suspect.suggested_action.command).toContain(
        "synapse lease create --flag search-algorithm --env production --value control --ttl 30m",
      );
    });

    it("suggests 1 when previous numeric value was 0", () => {
      const events: ChangeEvent[] = [
        {
          id: 506,
          event_type: "LEASE_CREATED",
          env: "production",
          flag_key: "retry-backoff",
          actor: "sre-alice",
          occurred_at: new Date(FIXED_NOW - 60000).toISOString(),
          payload: { value: 0 },
        },
      ];

      const [suspect] = rankSuspects(events, [], "worker-pool", FIXED_NOW);
      expect(suspect.suggested_action.suggested_value).toBe(1);
      expect(suspect.current_variant).toBe("0");
    });

    it("suggests disabled when previous value was enabled (and vice-versa)", () => {
      const events: ChangeEvent[] = [
        {
          id: 507,
          event_type: "LEASE_CREATED",
          env: "production",
          flag_key: "cache-layer",
          actor: "sre-alice",
          occurred_at: new Date(FIXED_NOW - 60000).toISOString(),
          payload: { value: "enabled" },
        },
      ];

      const [suspect] = rankSuspects(events, [], "cache-service", FIXED_NOW);
      expect(suspect.suggested_action.suggested_value).toBe("disabled");
      expect(suspect.current_variant).toBe("enabled");
    });

    it("handles future-dated events gracefully without negative delta or NaN decay", () => {
      const events: ChangeEvent[] = [
        {
          id: 508,
          event_type: "LEASE_CREATED",
          env: "production",
          flag_key: "future-flag",
          actor: "sre-alice",
          occurred_at: new Date(FIXED_NOW + 5000).toISOString(), // 5s in the future
          payload: { value: true },
        },
      ];

      const [suspect] = rankSuspects(events, [], "service", FIXED_NOW);
      expect(suspect.recency_score).toBe(100);
      expect(Number.isNaN(suspect.score)).toBe(false);
    });

    it("handles multiple change events for the same flag by picking the latest", () => {
      const events: ChangeEvent[] = [
        {
          id: 601,
          event_type: "LEASE_CREATED",
          env: "production",
          flag_key: "checkout-v2",
          actor: "sre-alice",
          occurred_at: new Date(FIXED_NOW - 30 * 60 * 1000).toISOString(),
          payload: { value: true },
        },
        {
          id: 602,
          event_type: "LEASE_REVOKED",
          env: "production",
          flag_key: "checkout-v2",
          actor: "sre-bob",
          occurred_at: new Date(FIXED_NOW - 5 * 60 * 1000).toISOString(),
          payload: {},
        },
      ];

      const suspects = rankSuspects(events, [], "checkout-service", FIXED_NOW);
      expect(suspects).toHaveLength(1);
      expect(suspects[0].event_type).toBe("LEASE_REVOKED");
      expect(suspects[0].actor).toBe("sre-bob");
      expect(suspects[0].occurred_at).toBe(new Date(FIXED_NOW - 5 * 60 * 1000).toISOString());
    });
  });
});
