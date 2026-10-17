import React from "react";
import Link from "next/link";
import { controlApiClient } from "@/lib/api";
import { TelemetryChart } from "@/components/TelemetryChart";

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
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
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
          <h1 style={{ fontSize: "1.75rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
            Flag Inventory & Telemetry
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginTop: "4px" }}>
            In-memory aggregated zero-context evaluations, variant stability, and stale purger candidates.
          </p>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "4px",
            borderRadius: "8px",
            backgroundColor: "rgba(0, 0, 0, 0.3)",
            border: "1px solid var(--border-subtle)",
            gap: "4px",
          }}
        >
          {["prod", "staging", "dev"].map((env) => {
            const isActive = env === currentEnv;
            return (
              <Link
                key={env}
                href={`/flags?env=${env}`}
                id={`flag-env-select-${env}`}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  backgroundColor: isActive ? "#0284c7" : "transparent",
                  color: isActive ? "#ffffff" : "var(--text-secondary)",
                }}
              >
                {env}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Summary Stat Pills */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
        <div
          className="glass-panel"
          style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: "10px" }}
        >
          <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Total Flags:</span>
          <span style={{ fontSize: "1.125rem", fontWeight: 700, color: "var(--text-primary)" }}>
            {inventory.length}
          </span>
        </div>

        <div
          className="glass-panel"
          style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: "10px" }}
        >
          <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Active Overrides:</span>
          <span
            style={{
              fontSize: "1.125rem",
              fontWeight: 700,
              color: activeOverridesCount > 0 ? "var(--accent-amber)" : "var(--accent-emerald)",
            }}
          >
            {activeOverridesCount}
          </span>
        </div>

        <div
          className="glass-panel"
          style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: "10px" }}
        >
          <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
            Stale Purger Candidates:
          </span>
          <span
            style={{
              fontSize: "1.125rem",
              fontWeight: 700,
              color: purgeCandidatesCount > 0 ? "var(--accent-emerald)" : "var(--text-muted)",
            }}
          >
            {purgeCandidatesCount}
          </span>
        </div>
      </div>

      {/* Flag Inventory List */}
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        {filteredFlags.length === 0 ? (
          <div
            className="glass-panel"
            style={{ padding: "48px 24px", textAlign: "center", color: "var(--text-secondary)" }}
          >
            No flags found matching query in {currentEnv.toUpperCase()}.
          </div>
        ) : (
          filteredFlags.map((flag) => (
            <div
              key={flag.flagKey}
              id={`flag-row-${flag.flagKey}`}
              className="glass-panel"
              style={{
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                borderLeft: flag.activeLease
                  ? "4px solid var(--accent-amber)"
                  : flag.isCandidateForPurge
                  ? "4px solid var(--accent-emerald)"
                  : "4px solid var(--border-subtle)",
              }}
            >
              {/* Row Header */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  flexWrap: "wrap",
                  gap: "10px",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <h3
                      style={{
                        fontSize: "1.0625rem",
                        fontWeight: 700,
                        fontFamily: "var(--font-mono)",
                        color: "var(--text-primary)",
                      }}
                    >
                      {flag.flagKey}
                    </h3>

                    {flag.activeLease && (
                      <span className="badge badge-near-expiry">Emergency Lease Active</span>
                    )}

                    {flag.isCandidateForPurge && (
                      <span className="badge badge-active" title="Qualified for synapse-purger AST cleanup PR">
                        Purger Candidate
                      </span>
                    )}
                  </div>

                  <div
                    style={{
                      fontSize: "0.8125rem",
                      color: "var(--text-muted)",
                      marginTop: "4px",
                    }}
                  >
                    Total Volume:{" "}
                    <strong style={{ color: "var(--text-secondary)" }}>
                      {flag.totalEvaluations.toLocaleString()}
                    </strong>{" "}
                    evaluations recorded
                  </div>
                </div>

                {flag.isQuiescent && flag.winningVariant && (
                  <div
                    style={{
                      padding: "4px 10px",
                      borderRadius: "6px",
                      backgroundColor: "rgba(16, 185, 129, 0.1)",
                      border: "1px solid rgba(16, 185, 129, 0.25)",
                      fontSize: "0.75rem",
                    }}
                  >
                    <span style={{ color: "var(--text-muted)" }}>Winning Variant: </span>
                    <strong style={{ color: "#34d399", fontFamily: "var(--font-mono)" }}>
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
            </div>
          ))
        )}
      </div>
    </div>
  );
}
