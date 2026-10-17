"use client";

import React, { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { UserRole } from "@/lib/types";
import { Card } from "@/components/ui/card";

export default function LoginPage() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selectedRole, setSelectedRole] = useState<UserRole>("operator");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const err = params.get("error");
      if (err === "github_oauth_not_configured") {
        setErrorMsg(
          "GitHub OAuth is not configured on this host (GITHUB_CLIENT_ID missing). Use the Development Session Switcher below for local testing."
        );
      } else if (err === "invalid_oauth_state") {
        setErrorMsg("OAuth state mismatch or expired. Please attempt sign-in again.");
      } else if (err === "oauth_exchange_failed") {
        setErrorMsg("Failed to exchange GitHub authorization code for session.");
      }
    }
  }, []);

  const handleDevRoleLogin = async (role: UserRole) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        startTransition(() => {
          router.push("/");
          router.refresh();
        });
      } else {
        setErrorMsg(data.message || data.error || `Authentication failed (${res.status})`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Authentication request failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "75vh",
        padding: "24px",
      }}
    >
      <Card
        style={{
          width: "100%",
          maxWidth: "480px",
          padding: "40px 32px",
          display: "flex",
          flexDirection: "column",
          gap: "28px",
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.03)",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--color-kumo-brand)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px auto",
              boxShadow: "0 2px 8px rgba(255, 94, 31, 0.3)",
            }}
          >
            <span style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-cream)" }}>⚡</span>
          </div>
          <h1
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "26px",
              fontWeight: 500,
              letterSpacing: "-0.6px",
              color: "var(--color-ink)",
            }}
          >
            SynapseState Portal
          </h1>
          <p style={{ color: "var(--color-muted)", fontSize: "14px", marginTop: "4px" }}>
            Authenticate with GitHub OIDC or switch dev session roles
          </p>
        </div>

        {errorMsg && (
          <div
            style={{
              padding: "12px 14px",
              borderRadius: "var(--radius-xs)",
              backgroundColor: "#fff1f2",
              border: "1px solid #fecdd3",
              color: "var(--color-under-attack)",
              fontSize: "13px",
              lineHeight: 1.4,
            }}
          >
            {errorMsg}
          </div>
        )}

        {/* GitHub OIDC Single Sign-On Link */}
        <a
          id="btn-github-oidc-login"
          href="/api/auth/github"
          className="btn-pill-brand"
          style={{
            width: "100%",
            fontSize: "15px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textDecoration: "none",
            gap: "8px",
          }}
        >
          <span>Sign In with GitHub OIDC</span>
        </a>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            color: "var(--color-muted)",
          }}
        >
          <div style={{ flex: 1, height: "1px", backgroundColor: "var(--color-hairline)" }} />
          <span className="mono-caption" style={{ fontSize: "11px" }}>
            DEVELOPMENT SESSION SWITCHER
          </span>
          <div style={{ flex: 1, height: "1px", backgroundColor: "var(--color-hairline)" }} />
        </div>

        {/* Role Switcher Cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {[
            {
              role: "operator" as UserRole,
              title: "Operator Role (Recommended)",
              desc: "Can inspect leases, trigger revocations, and view incident attribution.",
              color: "var(--color-kumo-brand)",
            },
            {
              role: "admin" as UserRole,
              title: "Admin Role",
              desc: "Full administrative controls and service retirement capabilities.",
              color: "var(--color-sase)",
            },
            {
              role: "viewer" as UserRole,
              title: "Viewer Role",
              desc: "Read-only access. Blocked from revoking or mutating leases.",
              color: "var(--color-compute)",
            },
          ].map((item) => (
            <div
              key={item.role}
              id={`role-option-${item.role}`}
              onClick={() => {
                setSelectedRole(item.role);
                handleDevRoleLogin(item.role);
              }}
              style={{
                padding: "16px",
                borderRadius: "var(--radius-md)",
                backgroundColor: "var(--color-cream)",
                border: "1px solid var(--color-hairline)",
                cursor: "pointer",
                transition: "border-color 0.15s ease",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    color: item.color,
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <span
                    style={{
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      backgroundColor: item.color,
                    }}
                  />
                  {item.title}
                </span>
                <span
                  className="btn btn-secondary"
                  style={{ fontSize: "12px", height: "26px", padding: "2px 8px" }}
                >
                  {loading && selectedRole === item.role ? "Switching..." : "Switch"}
                </span>
              </div>
              <p style={{ fontSize: "12.5px", color: "var(--color-muted)", marginTop: "4px", lineHeight: 1.4 }}>
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
