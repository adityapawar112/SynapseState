import React from "react";
import type { UserRole } from "@/lib/types";

interface RoleBadgeProps {
  role: UserRole;
  showPermissions?: boolean;
}

export function RoleBadge({ role, showPermissions = false }: RoleBadgeProps) {
  const roleStyles: Record<UserRole, { bg: string; color: string; border: string; label: string; desc: string }> = {
    viewer: {
      bg: "rgba(56, 189, 248, 0.12)",
      color: "#38bdf8",
      border: "rgba(56, 189, 248, 0.3)",
      label: "Viewer",
      desc: "Read-only access to state, logs, and telemetry",
    },
    operator: {
      bg: "rgba(245, 158, 11, 0.12)",
      color: "#fbbf24",
      border: "rgba(245, 158, 11, 0.3)",
      label: "Operator",
      desc: "Authorized to revoke emergency leases and promote to Git",
    },
    admin: {
      bg: "rgba(168, 85, 247, 0.12)",
      color: "#c084fc",
      border: "rgba(168, 85, 247, 0.3)",
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
          gap: "4px",
          padding: "3px 10px",
          borderRadius: "9999px",
          fontSize: "0.75rem",
          fontWeight: 600,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          backgroundColor: current.bg,
          color: current.color,
          border: `1px solid ${current.border}`,
        }}
        title={current.desc}
      >
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            backgroundColor: current.color,
          }}
        />
        {current.label}
      </span>
      {showPermissions && (
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          ({current.desc})
        </span>
      )}
    </div>
  );
}
