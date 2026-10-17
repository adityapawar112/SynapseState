"use client";

import React, { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { UserRole } from "@/lib/types";

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
        minHeight: "70vh",
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: "100%",
          maxWidth: "480px",
          padding: "32px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "12px",
              background: "linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 12px auto",
              boxShadow: "0 0 20px rgba(56, 189, 248, 0.4)",
              fontSize: "24px",
            }}
          >
            ⚡
          </div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 800 }}>SynapseState Portal</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginTop: "4px" }}>
            Authenticate with GitHub OIDC or switch dev session roles
          </p>
        </div>

        {errorMsg && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "6px",
              backgroundColor: "rgba(244, 63, 94, 0.15)",
              border: "1px solid rgba(244, 63, 94, 0.35)",
              color: "#fecdd3",
              fontSize: "0.8125rem",
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
          className="btn btn-primary"
          style={{
            width: "100%",
            padding: "12px",
            fontSize: "0.9375rem",
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
            color: "var(--text-muted)",
            fontSize: "0.75rem",
          }}
        >
          <div style={{ flex: 1, height: "1px", backgroundColor: "var(--border-subtle)" }} />
          <span>DEVELOPMENT SESSION SWITCHER</span>
          <div style={{ flex: 1, height: "1px", backgroundColor: "var(--border-subtle)" }} />
        </div>

        {/* Role Switcher Cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {[
            {
              role: "operator" as UserRole,
              title: "Operator Role (Recommended)",
              desc: "Can inspect leases, trigger revocations, and view incident attribution.",
              color: "var(--accent-amber)",
            },
            {
              role: "admin" as UserRole,
              title: "Admin Role",
              desc: "Full administrative controls and service retirement capabilities.",
              color: "var(--accent-purple)",
            },
            {
              role: "viewer" as UserRole,
              title: "Viewer Role",
              desc: "Read-only access. Blocked from revoking or mutating leases.",
              color: "var(--accent-cyan)",
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
                padding: "14px",
                borderRadius: "8px",
                backgroundColor: "rgba(0, 0, 0, 0.25)",
                border: "1px solid var(--border-subtle)",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "0.875rem", fontWeight: 700, color: item.color }}>
                  {item.title}
                </span>
                <span className="btn btn-secondary" style={{ fontSize: "0.6875rem", padding: "2px 8px" }}>
                  {loading && selectedRole === item.role ? "Switching..." : "Switch"}
                </span>
              </div>
              <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "4px" }}>
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
