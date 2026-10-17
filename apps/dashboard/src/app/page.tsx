import React from "react";
import Link from "next/link";
import { controlApiClient } from "@/lib/api";
import { LeaseCard } from "@/components/LeaseCard";
import { cookies } from "next/headers";
import { verifySessionToken, getDevSessionUser, getSessionSecret } from "@/lib/auth";
import type { UserRole } from "@/lib/types";
import { Card, CardOrange } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* =========================================================================
          HERO: Voltage as Canvas (Brand Orange Full-Bleed Canvas & Cream Display)
          ========================================================================= */}
      <section
        style={{
          backgroundColor: "var(--color-kumo-brand)",
          color: "var(--color-cream)",
          padding: "72px 24px 64px 24px",
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "20px",
        }}
      >
        <div style={{ maxWidth: "860px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div
            className="mono-caption"
            style={{
              color: "rgba(255, 251, 245, 0.85)",
              letterSpacing: "0.08em",
            }}
          >
            OPENFEATURE INCIDENT-SAFETY & LIFECYCLE GOVERNANCE
          </div>

          <h1
            className="display-xl"
            style={{
              color: "var(--color-cream)",
              margin: 0,
            }}
          >
            Signed incident governance for OpenFeature.
          </h1>

          <p
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "19.2px",
              fontWeight: 400,
              lineHeight: "26px",
              color: "rgba(255, 251, 245, 0.9)",
              maxWidth: "680px",
              margin: "0 auto",
            }}
          >
            In-process fail-safe delegation, air-gapped cryptographic break-glass overrides,
            and compiler-verified dead-flag cleanup PRs.
          </p>

          {/* Centered Cream Pill CTA */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              marginTop: "12px",
              flexWrap: "wrap",
            }}
          >
            <Link
              href={`/leases?env=${currentEnv}`}
              id="hero-cta-btn"
              className="btn-pill-cream"
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "15px",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span>Inspect Active Overrides</span>
              <span style={{ fontSize: "14px" }}>→</span>
            </Link>

            <Link
              href="#runbook-section"
              className="btn"
              style={{
                color: "var(--color-cream)",
                border: "1px solid rgba(255, 251, 245, 0.35)",
                borderRadius: "var(--radius-full)",
                padding: "12px 22px",
                height: "46px",
                fontSize: "14px",
                fontWeight: 500,
              }}
            >
              Operator Runbook
            </Link>
          </div>

          {/* Monospace Metadata Chips */}
          <div
            className="mono-caption"
            style={{
              display: "flex",
              justifyContent: "center",
              flexWrap: "wrap",
              gap: "16px",
              marginTop: "16px",
              color: "rgba(255, 251, 245, 0.75)",
            }}
          >
            <span>• AIR-GAPPED ROOT OF TRUST</span>
            <span>• DUAL-CLOCK EXPIRY BOUND</span>
            <span>• ZERO-CONTEXT TELEMETRY</span>
          </div>
        </div>
      </section>

      {/* =========================================================================
          BELOW THE FOLD: Inverts to Warm Cream / Canvas with Hairline Cards
          ========================================================================= */}
      <div
        style={{
          maxWidth: "1280px",
          width: "100%",
          margin: "0 auto",
          padding: "48px 24px 64px 24px",
          display: "flex",
          flexDirection: "column",
          gap: "40px",
        }}
      >
        {/* Environment Filter Bar */}
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
            <span className="mono-caption" style={{ color: "var(--color-muted)" }}>
              RUNTIME DOMAIN
            </span>
            <h2
              className="heading-md"
              style={{
                fontSize: "22px",
                fontWeight: 500,
                color: "var(--color-ink)",
                letterSpacing: "-0.4px",
                marginTop: "2px",
              }}
            >
              Operational State & Telemetry
            </h2>
          </div>

          {/* Environment Selector Pills */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {["prod", "staging", "dev"].map((env) => {
              const isActive = env === currentEnv;
              return (
                <Link
                  key={env}
                  href={`/?env=${env}`}
                  id={`env-select-${env}`}
                  className={`category-tab ${isActive ? "category-tab-active" : ""}`}
                  style={{ textTransform: "uppercase", fontSize: "12px", fontFamily: "var(--font-mono)" }}
                >
                  {env}
                </Link>
              );
            })}
          </div>
        </div>

        {/* 4-up Metric Stat Cards Grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
            gap: "16px",
          }}
        >
          {/* Card 1: Active Leases (Storage Pink Accent) */}
          <div className="stat-card" id="stat-active-leases">
            <div className="stat-label">Active Break-Glass Leases</div>
            <div
              className="stat-value"
              style={{
                color:
                  overview.activeLeasesCount > 0
                    ? "var(--color-kumo-brand)"
                    : "var(--color-ink)",
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

          {/* Card 2: Managed Flags (Compute Blue Accent) */}
          <div className="stat-card" id="stat-managed-flags">
            <div className="stat-label">Observed Flags ({currentEnv})</div>
            <div className="stat-value" style={{ color: "var(--color-compute)" }}>
              {overview.totalFlagsCount}
            </div>
            <div className="stat-hint">Registered flags with recorded evaluations</div>
          </div>

          {/* Card 3: 24h Evaluations */}
          <div className="stat-card" id="stat-evaluations-volume">
            <div className="stat-label">Evaluations (24h Window)</div>
            <div className="stat-value" style={{ color: "var(--color-ink)" }}>
              {overview.totalEvaluations24h.toLocaleString()}
            </div>
            <div className="stat-hint">Zero-context in-memory telemetry rollups</div>
          </div>

          {/* Card 4: Audit Ledger (SASE Teal Accent) */}
          <div className="stat-card" id="stat-audit-checkpoint">
            <div className="stat-label">Sealed Audit Events</div>
            <div className="stat-value" style={{ color: "var(--color-sase)" }}>
              {overview.sealedAuditCount}
            </div>
            <div className="stat-hint">
              Latest Checkpoint Seq: #{overview.latestCheckpointSeq}
            </div>
          </div>
        </div>

        {/* Active Emergency Leases Section */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <h2
                style={{
                  fontSize: "18px",
                  fontWeight: 500,
                  fontFamily: "var(--font-sans)",
                  color: "var(--color-ink)",
                  letterSpacing: "-0.3px",
                }}
              >
                Active Emergency Overrides
              </h2>
              {overview.activeLeasesCount > 0 && (
                <Badge variant="nearExpiry">
                  {overview.activeLeasesCount} Active
                </Badge>
              )}
            </div>
            <Link
              href={`/leases?env=${currentEnv}`}
              className="btn btn-secondary"
              style={{ fontSize: "13px", height: "32px", padding: "4px 12px" }}
            >
              View All Leases →
            </Link>
          </div>

          {overview.activeLeases.length === 0 ? (
            <Card
              style={{
                padding: "48px 24px",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <div style={{ fontSize: "28px" }}>🛡️</div>
              <h3 style={{ fontSize: "16px", fontWeight: 500, color: "var(--color-ink)" }}>
                No Active Break-Glass Leases in {currentEnv.toUpperCase()}
              </h3>
              <p
                style={{
                  fontSize: "14px",
                  color: "var(--color-muted)",
                  maxWidth: "520px",
                  lineHeight: 1.5,
                }}
              >
                Application workloads are evaluating feature flags normally through the delegate
                OpenFeature provider. To initiate an emergency break-glass override during an
                incident, run <code className="code-inline">synapse lease apply</code> from an
                authorized operator workstation.
              </p>
            </Card>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
                gap: "16px",
              }}
            >
              {overview.activeLeases.map((lease) => (
                <LeaseCard key={lease.leaseId} lease={lease} userRole={role} />
              ))}
            </div>
          )}
        </div>

        {/* =========================================================================
            SPLIT PANEL: Hairline Card (Left 50%) + Orange Emphasis Card (Right 50%)
            ========================================================================= */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
            gap: "20px",
          }}
        >
          {/* Left: Air-Gapped Trust Root Card */}
          <Card style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "14px" }}>
            <span className="mono-caption" style={{ color: "var(--color-sase)" }}>
              SAFETY INVARIANT 2
            </span>
            <h3 style={{ fontSize: "22px", fontWeight: 500, letterSpacing: "-0.5px" }}>
              Air-Gapped Private Keys
            </h3>
            <p style={{ fontSize: "14px", color: "var(--color-muted)", lineHeight: 1.6 }}>
              SDKs verify Ed25519 signatures against a locally pinned keyset mounted from Git.
              The Control API and web tier never store or manipulate private signing keys. Even under
              complete control-plane compromise, an attacker cannot forge valid overrides.
            </p>
            <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid var(--color-hairline)" }}>
              <code className="code-inline" style={{ fontSize: "12px" }}>
                synapse key export-public --kid &lt;key-id&gt;
              </code>
            </div>
          </Card>

          {/* Right: Voltage Emphasis Split Panel Card */}
          <CardOrange style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "14px" }}>
            <span className="mono-caption" style={{ color: "rgba(255, 251, 245, 0.85)" }}>
              SAFETY INVARIANT 3
            </span>
            <h3 style={{ fontSize: "22px", fontWeight: 500, color: "var(--color-cream)", letterSpacing: "-0.5px" }}>
              Dual-Clock Monotonic Expiry
            </h3>
            <p style={{ fontSize: "14px", color: "rgba(255, 251, 245, 0.9)", lineHeight: 1.6 }}>
              Overrides enforce both monotonic relative time per process incarnation
              (<code style={{ backgroundColor: "rgba(0,0,0,0.15)", padding: "2px 4px", borderRadius: "3px" }}>first_seen + ttl</code>)
              and wall-clock absolute bounds with skew tolerance. Zero leases can survive past their deadline.
            </p>
            <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid rgba(255, 251, 245, 0.25)" }}>
              <span className="mono-caption" style={{ color: "var(--color-cream)" }}>
                BOUND = MIN(WALL_CLOCK, MONOTONIC)
              </span>
            </div>
          </CardOrange>
        </div>

        {/* =========================================================================
            INCIDENT RUNBOOK: Clean Magazine / Documentation Strip
            ========================================================================= */}
        <Card
          id="runbook-section"
          style={{
            padding: "32px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          <div>
            <span className="mono-caption" style={{ color: "var(--color-compute)" }}>
              SRE WORKSTATION RUNBOOK
            </span>
            <h3
              style={{
                fontSize: "20px",
                fontWeight: 500,
                color: "var(--color-ink)",
                letterSpacing: "-0.4px",
                marginTop: "2px",
              }}
            >
              Operator CLI Commands
            </h3>
            <p style={{ fontSize: "14px", color: "var(--color-muted)", marginTop: "4px" }}>
              All state-mutating actions enforce dual-control and cryptographic signatures.
              Run these commands from your authenticated workstation:
            </p>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "16px",
            }}
          >
            {[
              {
                label: "Apply Emergency Break-Glass Override",
                cmd: `synapse lease apply <flag-key> <variant> --env ${currentEnv} --reason "Incident #123"`,
              },
              {
                label: "Investigate Suspect Flag Attribution",
                cmd: `synapse log --env ${currentEnv} --since 30m`,
              },
              {
                label: "Verify Cryptographic Audit Ledger",
                cmd: "synapse audit verify --from 1",
              },
              {
                label: "Promote Override to Permanent Git PR",
                cmd: "synapse promote <lease-id>",
              },
            ].map((item, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  padding: "14px",
                  borderRadius: "var(--radius-xs)",
                  backgroundColor: "var(--color-cream)",
                  border: "1px solid var(--color-hairline)",
                }}
              >
                <span className="mono-caption" style={{ color: "var(--color-muted)", fontSize: "11px" }}>
                  {item.label}
                </span>
                <code className="code-inline" style={{ overflowX: "auto", fontSize: "12px" }}>
                  {item.cmd}
                </code>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
