"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import type { UserRole } from "@/lib/types";

export default function LoginPage() {
  const router = useRouter();
  const [selectedRole, setSelectedRole] = useState<UserRole>("operator");
  const [loading, setLoading] = useState(false);

  const handleDevRoleLogin = async (role: UserRole) => {
    setLoading(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });

      if (res.ok) {
        router.push("/");
        router.refresh();
      }
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

        {/* GitHub OIDC Single Sign-On Button */}
        <button
          id="btn-github-oidc-login"
          type="button"
          className="btn btn-primary"
          style={{ width: "100%", padding: "12px", fontSize: "0.9375rem" }}
          onClick={() => handleDevRoleLogin(selectedRole)}
          disabled={loading}
        >
          <span>Sign In with GitHub OIDC</span>
        </button>

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
                  Switch
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
