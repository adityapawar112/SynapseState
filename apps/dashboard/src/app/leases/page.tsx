import React from "react";
import Link from "next/link";
import { controlApiClient } from "@/lib/api";
import { LeaseCard } from "@/components/LeaseCard";
import { cookies } from "next/headers";
import { verifySessionToken, getDevSessionUser, getSessionSecret } from "@/lib/auth";
import type { UserRole } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { LuClipboardList } from "react-icons/lu";

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
          <span className="mono-caption" style={{ color: "var(--color-storage)" }}>
            IN-PROCESS OVERRIDES
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
            Break-Glass Leases
          </h1>
          <p style={{ color: "var(--color-muted)", fontSize: "15px", marginTop: "4px" }}>
            Real-time emergency overrides enforcing dual-clock auto-expiry bounds.
          </p>
        </div>

        {/* Environment Selector Tabs */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {["prod", "staging", "dev"].map((env) => {
            const isActive = env === currentEnv;
            return (
              <Link
                key={env}
                href={`/leases?env=${env}&filter=${filter}`}
                id={`lease-env-select-${env}`}
                className={`category-tab ${isActive ? "category-tab-active" : ""}`}
                style={{ textTransform: "uppercase", fontSize: "12px", fontFamily: "var(--font-mono)" }}
              >
                {env}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Filter Tabs (Category-Tab Pills) */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          borderBottom: "1px solid var(--color-hairline)",
          paddingBottom: "16px",
          flexWrap: "wrap",
        }}
      >
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
              className={`category-tab ${isActive ? "category-tab-active" : ""}`}
              style={{ fontSize: "13px" }}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {/* Leases Grid */}
      {filteredLeases.length === 0 ? (
        <Card
          style={{
            padding: "56px 24px",
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "center", color: "var(--color-muted)" }}>
            <LuClipboardList size={38} />
          </div>
          <h3 style={{ fontSize: "18px", fontWeight: 500, color: "var(--color-ink)" }}>
            No Leases Found Matching Filter
          </h3>
          <p style={{ fontSize: "14px", color: "var(--color-muted)", maxWidth: "480px" }}>
            No emergency overrides in {currentEnv.toUpperCase()} matching status &quot;{filter}&quot;.
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
          {filteredLeases.map((lease) => (
            <LeaseCard key={lease.leaseId} lease={lease} userRole={role} />
          ))}
        </div>
      )}
    </div>
  );
}
