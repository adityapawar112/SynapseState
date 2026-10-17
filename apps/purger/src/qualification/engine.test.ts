import { describe, it, expect } from "vitest";
import {
  evaluateCandidateQuiescence,
  qualifyFlagTelemetryBatch,
} from "./engine.js";
import type { FlagTelemetrySnapshot } from "./types.js";

describe("Purger Quiescence Qualification Engine", () => {
  const baseValidSnapshot: FlagTelemetrySnapshot = {
    flagKey: "checkout-v2-flow",
    env: "production",
    flagClass: "release",
    hasActiveLease: false,
    windowDays: 35,
    firstSeen: "2026-09-01T00:00:00.000Z",
    lastSeen: "2026-10-06T00:00:00.000Z",
    variants: [
      {
        variant: "treatment",
        evalCount: 450000,
        firstSeen: "2026-09-01T00:00:00.000Z",
        lastSeen: "2026-10-06T00:00:00.000Z",
      },
    ],
    services: [
      {
        serviceName: "web-gateway",
        status: "ACTIVE",
        evalCount: 300000,
        lastSeen: "2026-10-06T00:00:00.000Z",
      },
      {
        serviceName: "checkout-svc",
        status: "ACTIVE",
        evalCount: 150000,
        lastSeen: "2026-10-06T00:00:00.000Z",
      },
    ],
  };

  it("qualifies standard release flag with single variant and ACTIVE consumer services", () => {
    const result = evaluateCandidateQuiescence(baseValidSnapshot);

    expect(result.status).toBe("QUALIFIED");
    expect(result.reasons).toEqual([]);
    expect(result.blockingServices).toBeUndefined();
    expect(result.candidate).toBeDefined();
    expect(result.candidate).toEqual({
      flagKey: "checkout-v2-flow",
      env: "production",
      winningVariant: "treatment",
      totalEvaluations: 450000,
      evaluatingServices: ["checkout-svc", "web-gateway"],
      windowDays: 35,
      firstSeen: "2026-09-01T00:00:00.000Z",
      lastSeen: "2026-10-06T00:00:00.000Z",
    });
  });

  it("disqualifies multi-variant active traffic (e.g. 95% variant A, 5% variant B)", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      variants: [
        {
          variant: "treatment",
          evalCount: 95000,
          firstSeen: "2026-09-01T00:00:00.000Z",
          lastSeen: "2026-10-06T00:00:00.000Z",
        },
        {
          variant: "control",
          evalCount: 5000,
          firstSeen: "2026-09-01T00:00:00.000Z",
          lastSeen: "2026-10-06T00:00:00.000Z",
        },
      ],
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("DISQUALIFIED");
    expect(result.reasons).toContain("MULTI_VARIANT_ACTIVE");
    expect(result.candidate).toBeUndefined();
  });

  it("disqualifies killswitch flag with single variant", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      flagClass: "killswitch",
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("DISQUALIFIED");
    expect(result.reasons).toContain("EXCLUDED_LIFECYCLE_CLASS");
    expect(result.candidate).toBeUndefined();
  });

  it("disqualifies permanent flag with single variant", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      flagClass: "permanent",
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("DISQUALIFIED");
    expect(result.reasons).toContain("EXCLUDED_LIFECYCLE_CLASS");
    expect(result.candidate).toBeUndefined();
  });

  it("disqualifies unregistered flag missing lifecycle classification", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      flagClass: undefined,
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("DISQUALIFIED");
    expect(result.reasons).toContain("UNREGISTERED_FLAG");
    expect(result.candidate).toBeUndefined();
  });

  it("disqualifies flag when active emergency lease exists", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      hasActiveLease: true,
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("DISQUALIFIED");
    expect(result.reasons).toContain("ACTIVE_LEASE_EXISTS");
    expect(result.candidate).toBeUndefined();
  });

  it("disqualifies flag when an evaluating service is SILENT and reports offending service", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      services: [
        {
          serviceName: "web-gateway",
          status: "ACTIVE",
          evalCount: 300000,
        },
        {
          serviceName: "recommendation-svc",
          status: "SILENT",
          evalCount: 50000,
        },
      ],
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("DISQUALIFIED");
    expect(result.reasons).toContain("BLOCKED_BY_SILENT_SERVICE");
    expect(result.blockingServices).toEqual(["recommendation-svc"]);
    expect(result.candidate).toBeUndefined();
  });

  it("aggregates and deduplicates multiple silent services in alphabetical order", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      services: [
        { serviceName: "zebra-service", status: "SILENT" },
        { serviceName: "alpha-service", status: "SILENT" },
        { serviceName: "alpha-service", status: "SILENT" },
        { serviceName: "beta-service", status: "ACTIVE" },
      ],
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("DISQUALIFIED");
    expect(result.reasons).toContain("BLOCKED_BY_SILENT_SERVICE");
    expect(result.blockingServices).toEqual(["alpha-service", "zebra-service"]);
  });

  it("qualifies when evaluating service has RETIRED status while other services are ACTIVE", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      services: [
        {
          serviceName: "web-gateway",
          status: "ACTIVE",
          evalCount: 300000,
        },
        {
          serviceName: "legacy-billing-svc",
          status: "RETIRED",
          evalCount: 150000,
        },
      ],
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("QUALIFIED");
    expect(result.reasons).toEqual([]);
    expect(result.blockingServices).toBeUndefined();
    expect(result.candidate?.evaluatingServices).toEqual([
      "legacy-billing-svc",
      "web-gateway",
    ]);
  });

  it("qualifies flag with 0 evaluations across entire window when defaultVariant is provided (without epoch sentinel)", () => {
    const snapshot: FlagTelemetrySnapshot = {
      flagKey: "abandoned-experiment",
      env: "production",
      flagClass: "release",
      defaultVariant: "off",
      hasActiveLease: false,
      windowDays: 35,
      variants: [],
      services: [],
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("QUALIFIED");
    expect(result.reasons).toEqual([]);
    expect(result.candidate).toBeDefined();
    expect(result.candidate).toEqual({
      flagKey: "abandoned-experiment",
      env: "production",
      winningVariant: "off",
      totalEvaluations: 0,
      evaluatingServices: [],
      windowDays: 35,
    });
    // Verifies I1: no bogus 1970-01-01 epoch sentinels
    expect(result.candidate?.firstSeen).toBeUndefined();
    expect(result.candidate?.lastSeen).toBeUndefined();
  });

  it("fails closed on 0-evaluation flag when defaultVariant is missing (C2)", () => {
    const snapshot: FlagTelemetrySnapshot = {
      flagKey: "zero-eval-unconfigured",
      env: "production",
      flagClass: "release",
      hasActiveLease: false,
      windowDays: 35,
      variants: [],
      services: [],
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("DISQUALIFIED");
    expect(result.reasons).toContain("MISSING_DEFAULT_VARIANT");
    expect(result.candidate).toBeUndefined();
  });

  it("disqualifies flag when recorded history window is insufficient (< 35 days)", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      windowDays: 21,
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("DISQUALIFIED");
    expect(result.reasons).toContain("INSUFFICIENT_WINDOW");
    expect(result.candidate).toBeUndefined();
  });

  it("disqualifies flag when telemetry history span is < minWindowDays even if windowDays requested is 35 (C1)", () => {
    // 2-day evaluation history span despite windowDays=35
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      windowDays: 35,
      firstSeen: "2026-10-04T00:00:00.000Z",
      lastSeen: "2026-10-06T00:00:00.000Z",
      variants: [
        {
          variant: "treatment",
          evalCount: 5000,
          firstSeen: "2026-10-04T00:00:00.000Z",
          lastSeen: "2026-10-06T00:00:00.000Z",
        },
      ],
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("DISQUALIFIED");
    expect(result.reasons).toContain("INSUFFICIENT_WINDOW");
    expect(result.candidate).toBeUndefined();
  });

  it("supports configurable minWindowDays option", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      windowDays: 14,
      firstSeen: "2026-09-20T00:00:00.000Z",
      lastSeen: "2026-10-06T00:00:00.000Z", // 16 days span
      variants: [
        {
          variant: "treatment",
          evalCount: 450000,
          firstSeen: "2026-09-20T00:00:00.000Z",
          lastSeen: "2026-10-06T00:00:00.000Z",
        },
      ],
    };

    // Fails with default 35 days
    const defaultResult = evaluateCandidateQuiescence(snapshot);
    expect(defaultResult.status).toBe("DISQUALIFIED");
    expect(defaultResult.reasons).toContain("INSUFFICIENT_WINDOW");

    // Passes when minWindowDays is configured to 14
    const customResult = evaluateCandidateQuiescence(snapshot, {
      minWindowDays: 14,
    });
    expect(customResult.status).toBe("QUALIFIED");
  });

  it("ignores variants with 0 evaluation counts when computing single-variant quiescence", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      variants: [
        {
          variant: "treatment",
          evalCount: 450000,
          firstSeen: "2026-09-01T00:00:00.000Z",
          lastSeen: "2026-10-06T00:00:00.000Z",
        },
        {
          variant: "control",
          evalCount: 0,
        },
      ],
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("QUALIFIED");
    expect(result.candidate?.winningVariant).toBe("treatment");
    expect(result.candidate?.totalEvaluations).toBe(450000);
  });

  it("accumulates multiple disqualification reasons simultaneously", () => {
    const snapshot: FlagTelemetrySnapshot = {
      ...baseValidSnapshot,
      flagClass: "killswitch",
      hasActiveLease: true,
      windowDays: 10,
      firstSeen: "2026-10-01T00:00:00.000Z",
      lastSeen: "2026-10-06T00:00:00.000Z",
      services: [{ serviceName: "silent-svc", status: "SILENT" }],
      variants: [
        { variant: "A", evalCount: 100 },
        { variant: "B", evalCount: 200 },
      ],
    };

    const result = evaluateCandidateQuiescence(snapshot);

    expect(result.status).toBe("DISQUALIFIED");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "EXCLUDED_LIFECYCLE_CLASS",
        "ACTIVE_LEASE_EXISTS",
        "INSUFFICIENT_WINDOW",
        "BLOCKED_BY_SILENT_SERVICE",
        "MULTI_VARIANT_ACTIVE",
      ]),
    );
    expect(result.blockingServices).toEqual(["silent-svc"]);
  });

  it("batch qualifies multiple snapshots preserving evaluation order and ensuring input immutability (M4)", () => {
    const snapshots: FlagTelemetrySnapshot[] = [
      baseValidSnapshot,
      {
        ...baseValidSnapshot,
        flagKey: "flag-killswitch",
        flagClass: "killswitch",
      },
      {
        ...baseValidSnapshot,
        flagKey: "flag-silent",
        services: [{ serviceName: "dead-worker", status: "SILENT" }],
      },
    ];

    // Verify immutability by freezing input objects
    const frozenSnapshots = snapshots.map((s) => Object.freeze({ ...s }));
    const results = qualifyFlagTelemetryBatch(frozenSnapshots);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe("QUALIFIED");
    expect(results[0].flagKey).toBe("checkout-v2-flow");
    expect(results[1].status).toBe("DISQUALIFIED");
    expect(results[1].flagKey).toBe("flag-killswitch");
    expect(results[2].status).toBe("DISQUALIFIED");
    expect(results[2].flagKey).toBe("flag-silent");
  });
});
