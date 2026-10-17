"use client";

import React, { useState, useEffect } from "react";
import type { ActiveLeaseView, UserRole } from "@/lib/types";
import { RevokeModal } from "@/components/RevokeModal";

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

  // Monotonic local ticker
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

  let badgeClass = "badge-active";
  let statusText = "Active";

  if (lease.status === "REVOKED") {
    badgeClass = "badge-revoked";
    statusText = "Revoked";
  } else if (lease.status === "PROMOTED") {
    badgeClass = "badge-promoted";
    statusText = "Promoted to Git";
  } else if (isExpired) {
    badgeClass = "badge-expired";
    statusText = "Expired";
  } else if (isNearExpiry) {
    badgeClass = "badge-near-expiry";
    statusText = "Near Expiry";
  }

  return (
    <>
      <div
        id={`lease-card-${lease.leaseId}`}
        className="glass-panel"
        style={{
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          borderLeft: isNearExpiry
            ? "4px solid var(--accent-amber)"
            : !isExpired
            ? "4px solid var(--accent-emerald)"
            : "4px solid var(--text-muted)",
        }}
      >
        {/* Header row: Flag Key & Status Badge */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className={`badge ${badgeClass}`}>{statusText}</span>
              <span className="code-inline" style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                {lease.env}
              </span>
            </div>
            <h3
              style={{
                fontSize: "1.125rem",
                fontWeight: 700,
                marginTop: "6px",
                fontFamily: "var(--font-mono)",
                color: "var(--text-primary)",
              }}
            >
              {lease.flagKey}
            </h3>
          </div>

          {/* Real-time countdown clock */}
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontSize: "0.75rem",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--text-muted)",
              }}
            >
              Remaining TTL
            </div>
            <div
              id={`lease-countdown-${lease.leaseId}`}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "1.25rem",
                fontWeight: 700,
                color: isNearExpiry
                  ? "var(--accent-amber)"
                  : !isExpired
                  ? "var(--accent-emerald)"
                  : "var(--text-muted)",
              }}
            >
              {formatDuration(remainingSeconds)}
            </div>
          </div>
        </div>

        {/* Forced Value & Reason */}
        <div
          style={{
            padding: "10px 12px",
            borderRadius: "6px",
            backgroundColor: "rgba(0, 0, 0, 0.25)",
            border: "1px solid var(--border-subtle)",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Forced Variant:</span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                color: "var(--accent-cyan)",
                fontSize: "0.9375rem",
              }}
            >
              {JSON.stringify(lease.value)}
            </span>
          </div>

          <div style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
            <span style={{ color: "var(--text-muted)" }}>Reason: </span>
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
            fontSize: "0.75rem",
            color: "var(--text-muted)",
            gap: "8px",
            paddingTop: "6px",
            borderTop: "1px solid var(--border-subtle)",
          }}
        >
          <div>
            <span>Actor KID: </span>
            <span className="code-inline">{lease.kid}</span>
            <span style={{ margin: "0 6px" }}>•</span>
            <span>Lease: </span>
            <span className="code-inline">{lease.leaseId.slice(0, 10)}…</span>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            {lease.promotePrUrl && (
              <a
                href={lease.promotePrUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary"
                style={{ fontSize: "0.75rem", padding: "4px 8px" }}
              >
                View Promotion PR ↗
              </a>
            )}

            {!isExpired && lease.status === "ACTIVE" && (
              <button
                id={`revoke-btn-${lease.leaseId}`}
                type="button"
                className="btn btn-danger"
                style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                onClick={() => setShowRevokeModal(true)}
              >
                Revoke Override
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
