"use client";

import React, { useState, useEffect } from "react";
import type { ActiveLeaseView, UserRole } from "@/lib/types";
import { RevokeModal } from "@/components/RevokeModal";
import { Badge } from "@/components/ui/badge";
import { LuExternalLink, LuBan, LuClock } from "react-icons/lu";

interface LeaseCardProps {
  lease: ActiveLeaseView;
  userRole?: UserRole;
  onRefresh?: () => void;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "Expired";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

export function LeaseCard({
  lease,
  userRole = "viewer",
  onRefresh,
}: LeaseCardProps) {
  const [remainingSeconds, setRemainingSeconds] = useState(lease.remainingSeconds);
  const [showRevokeModal, setShowRevokeModal] = useState(false);

  useEffect(() => {
    setRemainingSeconds(lease.remainingSeconds);
    if (lease.remainingSeconds <= 0) return;

    const timer = setInterval(() => {
      setRemainingSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);

    return () => clearInterval(timer);
  }, [lease.remainingSeconds]);

  const isExpired = remainingSeconds <= 0;
  const isNearExpiry = !isExpired && remainingSeconds <= 300;

  let badgeVariant:
    | "active"
    | "nearExpiry"
    | "expired"
    | "revoked"
    | "promoted" = "active";
  let statusText = "Active";

  if (lease.status === "REVOKED") {
    badgeVariant = "revoked";
    statusText = "Revoked";
  } else if (lease.status === "PROMOTED") {
    badgeVariant = "promoted";
    statusText = "Promoted to Git";
  } else if (isExpired) {
    badgeVariant = "expired";
    statusText = "Expired";
  } else if (isNearExpiry) {
    badgeVariant = "nearExpiry";
    statusText = "Near Expiry";
  }

  const borderLeftColor = isNearExpiry
    ? "var(--color-kumo-brand)"
    : !isExpired
    ? "var(--color-storage)"
    : "var(--color-hairline)";

  return (
    <>
      <div
        id={`lease-card-${lease.leaseId}`}
        className="card-hairline"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          borderLeft: `4px solid ${borderLeftColor}`,
        }}
      >
        {/* Header row: Status & Ticker */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Badge variant={badgeVariant}>{statusText}</Badge>
              <span className="code-inline" style={{ fontSize: "11px" }}>
                {lease.env}
              </span>
            </div>
            <h3
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "16px",
                fontWeight: 600,
                marginTop: "8px",
                color: "var(--color-ink)",
              }}
            >
              {lease.flagKey}
            </h3>
          </div>

          {/* Real-time countdown clock */}
          <div style={{ textAlign: "right" }}>
            <div className="mono-caption" style={{ color: "var(--color-muted)", marginBottom: "4px", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "4px" }}>
              <LuClock size={12} />
              <span>Remaining TTL</span>
            </div>
            <div
              id={`lease-countdown-${lease.leaseId}`}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "20px",
                fontWeight: 600,
                color: isNearExpiry
                  ? "var(--color-kumo-brand)"
                  : !isExpired
                  ? "var(--color-storage)"
                  : "var(--color-muted)",
              }}
            >
              {formatDuration(remainingSeconds)}
            </div>
          </div>
        </div>

        {/* Forced Value & Reason */}
        <div
          style={{
            padding: "12px 14px",
            borderRadius: "var(--radius-xs)",
            backgroundColor: "var(--color-cream)",
            border: "1px solid var(--color-hairline)",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span className="mono-caption" style={{ color: "var(--color-muted)" }}>
              Forced Variant:
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                color: "var(--color-storage)",
                fontSize: "14px",
              }}
            >
              {JSON.stringify(lease.value)}
            </span>
          </div>

          <div style={{ fontSize: "13px", color: "var(--color-ink-soft)", lineHeight: 1.4 }}>
            <span style={{ color: "var(--color-muted)", fontWeight: 500 }}>Reason: </span>
            {lease.reason}
          </div>
        </div>

        {/* Metadata Footer */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "12px",
            color: "var(--color-muted)",
            gap: "8px",
            paddingTop: "10px",
            borderTop: "1px solid var(--color-hairline)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span className="mono-caption">KID:</span>
            <span className="code-inline">{lease.kid}</span>
            <span style={{ margin: "0 4px" }}>•</span>
            <span className="mono-caption">Lease:</span>
            <span className="code-inline">{lease.leaseId.slice(0, 10)}…</span>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            {lease.promotePrUrl && (
              <a
                href={lease.promotePrUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary"
                style={{ fontSize: "12px", height: "32px", padding: "4px 10px", display: "inline-flex", alignItems: "center", gap: "5px" }}
              >
                <span>View Promotion PR</span>
                <LuExternalLink size={12} />
              </a>
            )}

            {!isExpired && lease.status === "ACTIVE" && userRole !== "viewer" && (
              <button
                id={`revoke-btn-${lease.leaseId}`}
                type="button"
                className="btn btn-danger"
                style={{ fontSize: "12px", height: "32px", padding: "4px 12px", display: "inline-flex", alignItems: "center", gap: "5px" }}
                onClick={() => setShowRevokeModal(true)}
              >
                <LuBan size={12} />
                <span>Revoke Override</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {showRevokeModal && (
        <RevokeModal
          lease={lease}
          userRole={userRole}
          onClose={() => setShowRevokeModal(false)}
          onRevoked={() => {
            setShowRevokeModal(false);
            if (onRefresh) onRefresh();
          }}
        />
      )}
    </>
  );
}
