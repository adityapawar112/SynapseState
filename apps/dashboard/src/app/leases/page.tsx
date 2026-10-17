import React from "react";
import Link from "next/link";
import { controlApiClient } from "@/lib/api";
import { LeaseCard } from "@/components/LeaseCard";
import { cookies } from "next/headers";
import { verifySessionToken, getDevSessionUser, getSessionSecret } from "@/lib/auth";
import type { UserRole } from "@/lib/types";

interface LeasesPageProps {
  searchParams?: Promise<{ env?: string; filter?: string }>;
}

export default async function LeasesPage({ searchParams }: LeasesPageProps) {
  const resolvedParams = searchParams ? await searchParams : {};
  const currentEnv = resolvedParams.env || "prod";
  const filter = resolvedParams.filter || "all";

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("synapse_session")?.value;
  const secret = getSessionSecret();

  let user = sessionCookie ? await verifySessionToken(sessionCookie, secret) : null;
  if (!user && process.env.NODE_ENV !== "production" && process.env.SYNAPSE_DEV_AUTH === "true") {
    user = getDevSessionUser("operator");
  }
  const role: UserRole = user?.role || "viewer";

  // Fetch active leases
  const allLeases = await controlApiClient.fetchActiveLeases(currentEnv);

  const filteredLeases = allLeases.filter((lease) => {
    if (filter === "active") return lease.remainingSeconds > 300;
    if (filter === "near-expiry") return lease.isNearExpiry;
    if (filter === "expired") return lease.remainingSeconds <= 0;
    return true;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Header & Controls */}
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
            Break-Glass Leases
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginTop: "4px" }}>
            Real-time emergency overrides enforcing dual-clock auto-expiry bounds.
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
                href={`/leases?env=${env}&filter=${filter}`}
                id={`lease-env-select-${env}`}
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

      {/* Filter Tabs */}
      <div style={{ display: "flex", gap: "8px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px" }}>
        {[
          { id: "all", label: `All Leases (${allLeases.length})` },
          { id: "active", label: "Active" },
          { id: "near-expiry", label: "Near Expiry (< 5m)" },
          { id: "expired", label: "Expired" },
        ].map((tab) => {
          const isActive = filter === tab.id;
          return (
            <Link
              key={tab.id}
              href={`/leases?env=${currentEnv}&filter=${tab.id}`}
              id={`lease-filter-tab-${tab.id}`}
              style={{
                fontSize: "0.8125rem",
                fontWeight: 600,
                padding: "6px 12px",
                borderRadius: "6px",
                backgroundColor: isActive ? "rgba(255, 255, 255, 0.08)" : "transparent",
                color: isActive ? "var(--text-primary)" : "var(--text-muted)",
              }}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {/* Leases Grid */}
      {filteredLeases.length === 0 ? (
        <div
          className="glass-panel"
          style={{
            padding: "48px 24px",
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "2.5rem" }}>📋</div>
          <h3 style={{ fontSize: "1.125rem", fontWeight: 600 }}>
            No Leases Found Matching Filter
          </h3>
          <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", maxWidth: "480px" }}>
            No emergency overrides in {currentEnv.toUpperCase()} matching status &quot;{filter}&quot;.
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
          {filteredLeases.map((lease) => (
            <LeaseCard key={lease.leaseId} lease={lease} userRole={role} />
          ))}
        </div>
      )}
    </div>
  );
}
