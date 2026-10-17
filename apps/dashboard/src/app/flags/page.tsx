import React from "react";
import Link from "next/link";
import { controlApiClient } from "@/lib/api";
import { TelemetryChart } from "@/components/TelemetryChart";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LuFlag, LuFlame, LuSparkles, LuCircleCheck } from "react-icons/lu";

interface FlagsPageProps {
  searchParams?: Promise<{ env?: string; search?: string }>;
}

export default async function FlagsPage({ searchParams }: FlagsPageProps) {
  const resolvedParams = searchParams ? await searchParams : {};
  const currentEnv = resolvedParams.env || "prod";
  const search = (resolvedParams.search || "").toLowerCase().trim();

  const inventory = await controlApiClient.fetchFlagInventory(currentEnv);

  const filteredFlags = inventory.filter((f) =>
    search ? f.flagKey.toLowerCase().includes(search) : true
  );

  const purgeCandidatesCount = inventory.filter((f) => f.isCandidateForPurge).length;
  const activeOverridesCount = inventory.filter((f) => Boolean(f.activeLease)).length;

  return (
    <div
      style={{
        maxWidth: "1280px",
        margin: "0 auto",
        padding: "40px 24px 64px 24px",
        display: "flex",
        flexDirection: "column",
        gap: "32px",
      }}
    >
      {/* Page Title & Environment Selector */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "16px",
        }}
      >
        <div>
          <span className="mono-caption" style={{ color: "var(--color-compute)" }}>
            IN-MEMORY TELEMETRY
          </span>
          <h1
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "36px",
              fontWeight: 500,
              letterSpacing: "-0.8px",
              color: "var(--color-ink)",
              marginTop: "2px",
            }}
          >
            Flag Inventory & Telemetry
          </h1>
          <p style={{ color: "var(--color-muted)", fontSize: "15px", marginTop: "4px" }}>
            In-process aggregated zero-context evaluations, variant stability, and stale purger candidates.
          </p>
        </div>

        {/* Environment Selector Pills */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {["prod", "staging", "dev"].map((env) => {
            const isActive = env === currentEnv;
            return (
              <Link
                key={env}
                href={`/flags?env=${env}`}
                id={`flag-env-select-${env}`}
                className={`category-tab ${isActive ? "category-tab-active" : ""}`}
                style={{ textTransform: "uppercase", fontSize: "12px", fontFamily: "var(--font-mono)" }}
              >
                {env}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Summary Stat Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "16px",
        }}
      >
        <div className="stat-card" style={{ padding: "18px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="stat-label">Observed Flags</div>
            <LuFlag size={16} color="var(--color-compute)" />
          </div>
          <div className="stat-value" style={{ fontSize: "28px" }}>
            {inventory.length}
          </div>
          <div className="stat-hint">Active OpenFeature flag keys</div>
        </div>

        <div className="stat-card" style={{ padding: "18px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="stat-label">Active Overrides</div>
            <LuFlame size={16} color="var(--color-storage)" />
          </div>
          <div
            className="stat-value"
            style={{
              fontSize: "28px",
              color: activeOverridesCount > 0 ? "var(--color-storage)" : "var(--color-ink)",
            }}
          >
            {activeOverridesCount}
          </div>
          <div className="stat-hint">In-process break-glass leases</div>
        </div>

        <div className="stat-card" style={{ padding: "18px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="stat-label">Stale Purger Candidates</div>
            <LuSparkles size={16} color="var(--color-ai)" />
          </div>
          <div
            className="stat-value"
            style={{
              fontSize: "28px",
              color: purgeCandidatesCount > 0 ? "var(--color-ai)" : "var(--color-muted)",
            }}
          >
            {purgeCandidatesCount}
          </div>
          <div className="stat-hint">&gt;99% variant quiescence verified</div>
        </div>
      </div>

      {/* Flag Inventory List */}
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {filteredFlags.length === 0 ? (
          <Card
            style={{
              padding: "48px 24px",
              textAlign: "center",
              color: "var(--color-muted)",
              fontSize: "14px",
            }}
          >
            No flags found matching query in {currentEnv.toUpperCase()}.
          </Card>
        ) : (
          filteredFlags.map((flag) => (
            <Card
              key={flag.flagKey}
              id={`flag-row-${flag.flagKey}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "16px",
                borderLeft: flag.activeLease
                  ? "4px solid var(--color-storage)"
                  : flag.isCandidateForPurge
                  ? "4px solid var(--color-ai)"
                  : "1px solid var(--color-hairline)",
              }}
            >
              {/* Row Header */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  flexWrap: "wrap",
                  gap: "12px",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <h3
                      style={{
                        fontSize: "16px",
                        fontWeight: 600,
                        fontFamily: "var(--font-mono)",
                        color: "var(--color-ink)",
                        margin: 0,
                      }}
                    >
                      {flag.flagKey}
                    </h3>

                    {flag.activeLease && (
                      <Badge variant="storage" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                        <LuFlame size={11} />
                        <span>Emergency Lease Active</span>
                      </Badge>
                    )}

                    {flag.isCandidateForPurge && (
                      <Badge variant="ai" title="Qualified for synapse-purger AST cleanup PR" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                        <LuSparkles size={11} />
                        <span>Purger Candidate</span>
                      </Badge>
                    )}
                  </div>

                  <div
                    style={{
                      fontSize: "13px",
                      color: "var(--color-muted)",
                      marginTop: "4px",
                    }}
                  >
                    Volume:{" "}
                    <strong style={{ color: "var(--color-ink)" }}>
                      {flag.totalEvaluations.toLocaleString()}
                    </strong>{" "}
                    in-memory zero-context evaluations recorded
                  </div>
                </div>

                {flag.isQuiescent && flag.winningVariant && (
                  <div
                    style={{
                      padding: "4px 10px",
                      borderRadius: "var(--radius-xs)",
                      backgroundColor: "rgba(0, 189, 125, 0.08)",
                      border: "1px solid rgba(0, 189, 125, 0.25)",
                      fontSize: "12px",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    <LuCircleCheck size={13} color="var(--color-ai)" />
                    <span style={{ color: "var(--color-muted)" }}>Dominant Variant: </span>
                    <strong style={{ color: "var(--color-ai)", fontFamily: "var(--font-mono)" }}>
                      {flag.winningVariant}
                    </strong>
                  </div>
                )}
              </div>

              {/* Telemetry Variant Distribution Chart */}
              <TelemetryChart
                variants={flag.variants}
                totalEvaluations={flag.totalEvaluations}
                winningVariant={flag.winningVariant}
              />
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
