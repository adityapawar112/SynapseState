import React from "react";
import Link from "next/link";
import { controlApiClient } from "@/lib/api";
import { LeaseCard } from "@/components/LeaseCard";
import { cookies } from "next/headers";
import { verifySessionToken, getDevSessionUser, getSessionSecret } from "@/lib/auth";
import type { UserRole } from "@/lib/types";

interface PageProps {
  searchParams?: Promise<{ env?: string }>;
}

export default async function DashboardOverviewPage({ searchParams }: PageProps) {
  const resolvedParams = searchParams ? await searchParams : {};
  const currentEnv = resolvedParams.env || "prod";

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("synapse_session")?.value;
  const secret = getSessionSecret();

  let user = sessionCookie ? await verifySessionToken(sessionCookie, secret) : null;
  if (!user && process.env.NODE_ENV !== "production" && process.env.SYNAPSE_DEV_AUTH === "true") {
    user = getDevSessionUser("operator");
  }
  const role: UserRole = user?.role || "viewer";

  // Fetch overview data from Control API
  const overview = await controlApiClient.fetchDashboardOverview(currentEnv);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      {/* Top Bar: Environment Switcher & Live Status */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "16px",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
            Operational Overview
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginTop: "4px" }}>
            Real-time status of emergency overrides, flag evaluations, and tamper-evident audit ledger.
          </p>
        </div>

        {/* Environment Selector */}
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
                href={`/?env=${env}`}
                id={`env-select-${env}`}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  backgroundColor: isActive ? "#0284c7" : "transparent",
                  color: isActive ? "#ffffff" : "var(--text-secondary)",
                  transition: "all 0.15s ease",
                }}
              >
                {env}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Metric Cards Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "16px",
        }}
      >
        {/* Card 1: Active Leases */}
        <div className="glass-panel stat-card" id="stat-active-leases">
          <div className="stat-label">Active Break-Glass Leases</div>
          <div
            className="stat-value"
            style={{
              color:
                overview.activeLeasesCount > 0 ? "var(--accent-amber)" : "var(--accent-emerald)",
            }}
          >
            {overview.activeLeasesCount}
          </div>
          <div className="stat-hint">
            {overview.activeLeasesCount > 0
              ? "Emergency overrides active in-process"
              : "Steady state: standard OpenFeature evaluation"}
          </div>
        </div>

        {/* Card 2: Managed Flags */}
        <div className="glass-panel stat-card" id="stat-managed-flags">
          <div className="stat-label">Observed Flags ({currentEnv})</div>
          <div className="stat-value" style={{ color: "var(--accent-cyan)" }}>
            {overview.totalFlagsCount}
          </div>
          <div className="stat-hint">Registered flags with recorded evaluations</div>
        </div>

        {/* Card 3: 24h Evaluations */}
        <div className="glass-panel stat-card" id="stat-evaluations-volume">
          <div className="stat-label">Evaluations (24h Window)</div>
          <div className="stat-value" style={{ color: "#ffffff" }}>
            {overview.totalEvaluations24h.toLocaleString()}
          </div>
          <div className="stat-hint">Zero-context in-memory telemetry rollups</div>
        </div>

        {/* Card 4: Audit Ledger Checkpoint */}
        <div className="glass-panel stat-card" id="stat-audit-checkpoint">
          <div className="stat-label">Sealed Audit Events</div>
          <div className="stat-value" style={{ color: "var(--accent-purple)" }}>
            {overview.sealedAuditCount}
          </div>
          <div className="stat-hint">
            Latest Checkpoint Seq: #{overview.latestCheckpointSeq}
          </div>
        </div>
      </div>

      {/* Active Leases Section */}
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700 }}>
              Active Emergency Overrides
            </h2>
            {overview.activeLeasesCount > 0 && (
              <span className="badge badge-near-expiry">
                {overview.activeLeasesCount} Live
              </span>
            )}
          </div>
          <Link
            href={`/leases?env=${currentEnv}`}
            className="btn btn-secondary"
            style={{ fontSize: "0.8125rem" }}
          >
            View All Leases →
          </Link>
        </div>

        {overview.activeLeases.length === 0 ? (
          <div
            className="glass-panel"
            style={{
              padding: "36px",
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "12px",
            }}
          >
            <div style={{ fontSize: "2rem" }}>🛡️</div>
            <h3 style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text-primary)" }}>
              No Active Break-Glass Leases in {currentEnv.toUpperCase()}
            </h3>
            <p
              style={{
                fontSize: "0.875rem",
                color: "var(--text-secondary)",
                maxWidth: "520px",
                lineHeight: 1.5,
              }}
            >
              Application workloads are evaluating feature flags normally through the delegate
              OpenFeature provider. To initiate an emergency break-glass override during an
              incident, run <code className="code-inline">synapse lease apply</code> from an
              authorized operator workstation.
            </p>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
              gap: "16px",
            }}
          >
            {overview.activeLeases.map((lease) => (
              <LeaseCard key={lease.leaseId} lease={lease} userRole={role} />
            ))}
          </div>
        )}
      </div>

      {/* Incident Attribution Runbook & Safety Guidance */}
      <div
        className="glass-panel"
        style={{
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          backgroundColor: "rgba(15, 23, 42, 0.4)",
        }}
      >
        <h3 style={{ fontSize: "1rem", fontWeight: 700, color: "var(--accent-cyan)" }}>
          ⚡ Operator Incident Runbook Commands
        </h3>
        <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
          All state-mutating actions enforce dual-control and cryptographic signatures. Run these
          commands on your workstation:
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Apply emergency break-glass override:
            </span>
            <code className="code-inline">
              synapse lease apply &lt;flag-key&gt; &lt;variant&gt; --env {currentEnv} --reason &quot;Incident #123&quot;
            </code>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Investigate recent flag changes (Suspect attribution):
            </span>
            <code className="code-inline">synapse log --env {currentEnv} --since 30m</code>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Verify cryptographic audit ledger hash chain:
            </span>
            <code className="code-inline">synapse audit verify --from 1</code>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Promote temporary lease to permanent Git PR:
            </span>
            <code className="code-inline">synapse promote &lt;lease-id&gt;</code>
          </div>
        </div>
      </div>
    </div>
  );
}
