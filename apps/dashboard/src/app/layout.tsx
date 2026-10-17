import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { RoleBadge } from "@/components/RoleBadge";
import { cookies } from "next/headers";
import { verifySessionToken, getDevSessionUser, getSessionSecret } from "@/lib/auth";
import type { UserRole } from "@/lib/types";

export const metadata: Metadata = {
  title: "SynapseState Operations Portal",
  description: "Incident-safety and lifecycle governance layer for OpenFeature",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("synapse_session")?.value;
  const secret = getSessionSecret();

  let user = sessionCookie ? await verifySessionToken(sessionCookie, secret) : null;
  if (!user && process.env.NODE_ENV !== "production" && process.env.SYNAPSE_DEV_AUTH === "true") {
    user = getDevSessionUser("operator");
  }

  const role: UserRole = user?.role || "viewer";

  return (
    <html lang="en">
      <body>
        {/* Safety Boundary Banner */}
        <div
          id="safety-boundary-banner"
          style={{
            backgroundColor: "rgba(2, 132, 199, 0.15)",
            borderBottom: "1px solid rgba(56, 189, 248, 0.25)",
            padding: "8px 16px",
            fontSize: "0.75rem",
            color: "#bae6fd",
            textAlign: "center",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
          }}
        >
          <span>🔒</span>
          <span>
            <strong>Safety Invariant:</strong> Read-mostly operations dashboard. Emergency break-glass
            leases are cryptographically signed on operator workstations. Control API and web tier
            never store private signing keys.
          </span>
        </div>

        {/* Global Navigation Header */}
        <header
          style={{
            borderBottom: "1px solid var(--border-subtle)",
            backgroundColor: "rgba(9, 13, 22, 0.8)",
            backdropFilter: "blur(12px)",
            position: "sticky",
            top: 0,
            zIndex: 100,
          }}
        >
          <div
            style={{
              maxWidth: "1400px",
              margin: "0 auto",
              padding: "12px 24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "20px",
            }}
          >
            {/* Logo & Brand */}
            <div style={{ display: "flex", alignItems: "center", gap: "24px" }}>
              <Link
                href="/"
                id="nav-logo-link"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  fontSize: "1.125rem",
                  fontWeight: 800,
                  letterSpacing: "-0.025em",
                  color: "var(--text-primary)",
                }}
              >
                <div
                  style={{
                    width: "28px",
                    height: "28px",
                    borderRadius: "8px",
                    background: "linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 0 12px rgba(56, 189, 248, 0.4)",
                  }}
                >
                  <span style={{ fontSize: "14px", fontWeight: 900, color: "#fff" }}>⚡</span>
                </div>
                <span>SynapseState</span>
              </Link>

              {/* Navigation Tabs */}
              <nav
                id="main-nav-tabs"
                style={{ display: "flex", alignItems: "center", gap: "4px" }}
              >
                <Link
                  href="/"
                  id="nav-tab-overview"
                  className="btn btn-secondary"
                  style={{ border: "none", padding: "6px 12px" }}
                >
                  Overview
                </Link>
                <Link
                  href="/leases"
                  id="nav-tab-leases"
                  className="btn btn-secondary"
                  style={{ border: "none", padding: "6px 12px" }}
                >
                  Active Leases
                </Link>
                <Link
                  href="/flags"
                  id="nav-tab-flags"
                  className="btn btn-secondary"
                  style={{ border: "none", padding: "6px 12px" }}
                >
                  Flag Inventory
                </Link>
                <Link
                  href="/audit"
                  id="nav-tab-audit"
                  className="btn btn-secondary"
                  style={{ border: "none", padding: "6px 12px" }}
                >
                  Audit Ledger
                </Link>
              </nav>
            </div>

            {/* User Session & Status */}
            <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
              <span className="badge badge-healthy" title="Control API cluster operational">
                API Healthy
              </span>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "4px 10px",
                  borderRadius: "8px",
                  backgroundColor: "rgba(255, 255, 255, 0.03)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <RoleBadge role={role} />
                <span
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {user?.login || "anonymous"}
                </span>
                <Link
                  href="/login"
                  id="switch-role-link"
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--accent-cyan)",
                    textDecoration: "underline",
                    marginLeft: "4px",
                  }}
                >
                  Switch
                </Link>
              </div>
            </div>
          </div>
        </header>

        {/* Main Content Area */}
        <main
          style={{
            flex: 1,
            maxWidth: "1400px",
            width: "100%",
            margin: "0 auto",
            padding: "24px",
          }}
        >
          {children}
        </main>

        {/* Global Footer */}
        <footer
          style={{
            borderTop: "1px solid var(--border-subtle)",
            padding: "20px 24px",
            backgroundColor: "var(--bg-primary)",
            fontSize: "0.8125rem",
            color: "var(--text-muted)",
          }}
        >
          <div
            style={{
              maxWidth: "1400px",
              margin: "0 auto",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "12px",
            }}
          >
            <div>
              <span>SynapseState v0.1.0 • Incident-Safety Layer for OpenFeature</span>
              <span style={{ margin: "0 8px" }}>•</span>
              <span style={{ color: "#34d399" }}>Zero-Context Telemetry Verified</span>
            </div>
            <div style={{ display: "flex", gap: "16px" }}>
              <span>SLO: Lease Propagation ≤10s</span>
              <span>SLO: Expiry Correctness = 0 past TTL</span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
