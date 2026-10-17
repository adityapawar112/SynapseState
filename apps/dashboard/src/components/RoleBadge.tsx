import React from "react";
import type { UserRole } from "@/lib/types";

interface RoleBadgeProps {
  role: UserRole;
  showPermissions?: boolean;
}

export function RoleBadge({ role, showPermissions = false }: RoleBadgeProps) {
  const roleStyles: Record<
    UserRole,
    { bg: string; color: string; label: string; desc: string }
  > = {
    viewer: {
      bg: "var(--color-compute)",
      color: "#ffffff",
      label: "Viewer",
      desc: "Read-only access to state, logs, and telemetry",
    },
    operator: {
      bg: "var(--color-kumo-brand)",
      color: "#ffffff",
      label: "Operator",
      desc: "Authorized to revoke emergency leases and promote to Git",
    },
    admin: {
      bg: "var(--color-sase)",
      color: "#ffffff",
      label: "Admin",
      desc: "Full administrative access and service lifecycle controls",
    },
  };

  const current = roleStyles[role] || roleStyles.viewer;

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
      <span
        id={`role-badge-${role}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "3px 10px",
          borderRadius: "var(--radius-full)",
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
          fontWeight: 600,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          backgroundColor: current.bg,
          color: current.color,
          border: "none",
        }}
        title={current.desc}
      >
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            backgroundColor: "#ffffff",
          }}
        />
        {current.label}
      </span>
      {showPermissions && (
        <span style={{ fontSize: "12px", color: "var(--color-muted)", fontFamily: "var(--font-sans)" }}>
          ({current.desc})
        </span>
      )}
    </div>
  );
}
