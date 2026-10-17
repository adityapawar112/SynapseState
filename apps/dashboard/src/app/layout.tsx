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
            backgroundColor: "var(--color-cream)",
            borderBottom: "1px solid var(--color-hairline)",
            padding: "8px 24px",
            fontSize: "12px",
            color: "var(--color-ink-soft)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: "var(--color-kumo-brand)",
                display: "inline-block",
              }}
            />
            <span>
              <strong>Safety Invariant:</strong> Read-mostly operations dashboard. Emergency break-glass
              leases are cryptographically signed on operator workstations. Control API and web tier never store private signing keys.
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <Link
              href="/leases"
              id="under-attack-link"
              style={{
                color: "var(--color-under-attack)",
                fontSize: "12px",
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Incident Response ↗
            </Link>
          </div>
        </div>

        {/* Global Navigation Header (Clean White 64px Hairline Nav) */}
        <header
          style={{
            borderBottom: "1px solid var(--color-hairline)",
            backgroundColor: "var(--color-canvas)",
            position: "sticky",
            top: 0,
            zIndex: 100,
            height: "64px",
            display: "flex",
            alignItems: "center",
          }}
        >
          <div
            style={{
              maxWidth: "1280px",
              width: "100%",
              margin: "0 auto",
              padding: "0 24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "24px",
            }}
          >
            {/* Logo & Navigation Tabs */}
            <div style={{ display: "flex", alignItems: "center", gap: "32px" }}>
              <Link
                href="/"
                id="nav-logo-link"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  fontSize: "18px",
                  fontWeight: 600,
                  letterSpacing: "-0.4px",
                  color: "var(--color-ink)",
                }}
              >
                <div
                  style={{
                    width: "28px",
                    height: "28px",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: "var(--color-kumo-brand)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-cream)" }}>⚡</span>
                </div>
                <span>SynapseState</span>
              </Link>

              {/* Navigation Tabs */}
              <nav
                id="main-nav-tabs"
                style={{ display: "flex", alignItems: "center", gap: "4px" }}
              >
                {[
                  { id: "nav-tab-overview", href: "/", label: "Overview" },
                  { id: "nav-tab-leases", href: "/leases", label: "Active Leases" },
                  { id: "nav-tab-flags", href: "/flags", label: "Flag Inventory" },
                  { id: "nav-tab-audit", href: "/audit", label: "Audit Ledger" },
                ].map((item) => (
                  <Link
                    key={item.href}
                    id={item.id}
                    href={item.href}
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: "14px",
                      fontWeight: 500,
                      color: "var(--color-nav-muted)",
                      padding: "6px 12px",
                      borderRadius: "var(--radius-md)",
                      transition: "all 0.15s ease",
                    }}
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>

            {/* User Session & Status Affordances */}
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  color: "var(--color-ai)",
                  backgroundColor: "rgba(0, 189, 125, 0.1)",
                  border: "1px solid rgba(0, 189, 125, 0.25)",
                  padding: "3px 8px",
                  borderRadius: "var(--radius-full)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Mesh Online
              </span>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "4px 10px",
                  borderRadius: "var(--radius-full)",
                  backgroundColor: "var(--color-cream)",
                  border: "1px solid var(--color-hairline)",
                }}
              >
                <RoleBadge role={role} />
                <span
                  style={{
                    fontSize: "12px",
                    color: "var(--color-ink-soft)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {user?.login || "anonymous"}
                </span>
                <Link
                  href="/login"
                  id="switch-role-link"
                  style={{
                    fontSize: "12px",
                    color: "var(--color-kumo-brand)",
                    fontWeight: 500,
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
            width: "100%",
          }}
        >
          {children}
        </main>

        {/* Global Footer (Hairline Top Border & Monospace Captions) */}
        <footer
          style={{
            borderTop: "1px solid var(--color-hairline)",
            backgroundColor: "var(--color-canvas)",
            padding: "24px",
            fontSize: "13px",
            color: "var(--color-muted)",
          }}
        >
          <div
            style={{
              maxWidth: "1280px",
              margin: "0 auto",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "16px",
            }}
          >
            <div>
              <span style={{ fontWeight: 500, color: "var(--color-ink)" }}>SynapseState</span>
              <span style={{ margin: "0 8px" }}>•</span>
              <span>Incident-Safety & Lifecycle Governance for OpenFeature</span>
              <span style={{ margin: "0 8px" }}>•</span>
              <span style={{ color: "var(--color-ai)", fontFamily: "var(--font-mono)", fontSize: "11px" }}>
                ZERO-CONTEXT TELEMETRY VERIFIED
              </span>
            </div>
            <div
              className="mono-caption"
              style={{ display: "flex", gap: "20px", color: "var(--color-muted)" }}
            >
              <span>PROPAGATION ≤ 10S</span>
              <span>EXPIRY DEADLINE = 0 PAST TTL</span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
