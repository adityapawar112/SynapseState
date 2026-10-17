import React from "react";
import Link from "next/link";
import { controlApiClient } from "@/lib/api";
import { verifyAuditLedgerChain } from "@/lib/domain";

interface AuditPageProps {
  searchParams?: Promise<{ from_seq?: string; limit?: string }>;
}

export default async function AuditLedgerPage({ searchParams }: AuditPageProps) {
  const resolvedParams = searchParams ? await searchParams : {};
  const fromSeq = parseInt(resolvedParams.from_seq || "1", 10) || 1;
  const limit = parseInt(resolvedParams.limit || "50", 10) || 50;

  const [auditData, latestCheckpoint] = await Promise.all([
    controlApiClient.fetchAuditEvents({ fromSeq, limit }),
    controlApiClient.fetchLatestCheckpoint(),
  ]);

  const chainVerification = verifyAuditLedgerChain(auditData.events);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Title & Checkpoint Header */}
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
          <h1 style={{ fontSize: "1.75rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
            Tamper-Evident Audit Ledger
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginTop: "4px" }}>
            Append-only single-writer PostgreSQL hash chain sealed with SHA-256 and verified against signed external checkpoints.
          </p>
        </div>

        {/* Verification Status Badge */}
        <div
          id="audit-chain-status-badge"
          style={{
            padding: "8px 16px",
            borderRadius: "8px",
            backgroundColor: chainVerification.valid
              ? "rgba(16, 185, 129, 0.12)"
              : "rgba(244, 63, 94, 0.15)",
            border: chainVerification.valid
              ? "1px solid rgba(16, 185, 129, 0.3)"
              : "1px solid rgba(244, 63, 94, 0.4)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span style={{ fontSize: "1rem" }}>{chainVerification.valid ? "🛡️" : "⚠️"}</span>
          <div>
            <div
              style={{
                fontSize: "0.75rem",
                fontWeight: 700,
                color: chainVerification.valid ? "#34d399" : "#f87171",
                textTransform: "uppercase",
              }}
            >
              {chainVerification.valid ? "Hash Chain Verified" : "Tampering Detected"}
            </div>
            <div style={{ fontSize: "0.6875rem", color: "var(--text-muted)" }}>
              {chainVerification.valid
                ? "Cryptographic SHA-256 continuity unbroken"
                : `Sequence discontinuity at seq #${chainVerification.brokenAtSeq}`}
            </div>
          </div>
        </div>
      </div>

      {/* Latest Signed Checkpoint Panel */}
      <div
        className="glass-panel"
        style={{
          padding: "20px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "16px",
          backgroundColor: "rgba(15, 23, 42, 0.5)",
        }}
      >
        <div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase" }}>
            Latest Checkpoint Seq
          </div>
          <div style={{ fontSize: "1.25rem", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
            #{latestCheckpoint.checkpointSeq}
          </div>
        </div>

        <div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase" }}>
            Total Sealed Records
          </div>
          <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>
            {latestCheckpoint.sealedCount.toLocaleString()} events
          </div>
        </div>

        <div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase" }}>
            Sealed Checkpoint Hash
          </div>
          <div
            className="code-inline"
            style={{
              fontSize: "0.75rem",
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={latestCheckpoint.checkpointHash}
          >
            {latestCheckpoint.checkpointHash}
          </div>
        </div>

        <div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase" }}>
            Checkpoint Timestamp
          </div>
          <div style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
            {latestCheckpoint.timestamp
              ? new Date(latestCheckpoint.timestamp).toLocaleString()
              : "Genesis initial"}
          </div>
        </div>
      </div>

      {/* Events Table */}
      <div className="glass-panel" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <thead>
            <tr
              style={{
                borderBottom: "1px solid var(--border-subtle)",
                textAlign: "left",
                color: "var(--text-muted)",
              }}
            >
              <th style={{ padding: "12px 16px" }}>Seq</th>
              <th style={{ padding: "12px 16px" }}>Timestamp</th>
              <th style={{ padding: "12px 16px" }}>Event Type</th>
              <th style={{ padding: "12px 16px" }}>Actor KID</th>
              <th style={{ padding: "12px 16px" }}>Event SHA-256 Hash</th>
              <th style={{ padding: "12px 16px" }}>Payload Details</th>
            </tr>
          </thead>
          <tbody>
            {auditData.events.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: "36px", textAlign: "center", color: "var(--text-muted)" }}>
                  No sealed audit records found.
                </td>
              </tr>
            ) : (
              auditData.events.map((event) => (
                <tr
                  key={event.seq}
                  style={{
                    borderBottom: "1px solid rgba(255, 255, 255, 0.04)",
                  }}
                >
                  <td style={{ padding: "12px 16px", fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                    #{event.seq}
                  </td>
                  <td style={{ padding: "12px 16px", color: "var(--text-secondary)" }}>
                    {new Date(event.ts).toLocaleTimeString()}
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <span
                      className="badge"
                      style={{
                        backgroundColor:
                          event.eventType.includes("REVOKE")
                            ? "rgba(244, 63, 94, 0.15)"
                            : event.eventType.includes("PROMOTE")
                            ? "rgba(168, 85, 247, 0.15)"
                            : "rgba(56, 189, 248, 0.12)",
                        color:
                          event.eventType.includes("REVOKE")
                            ? "#fda4af"
                            : event.eventType.includes("PROMOTE")
                            ? "#d8b4fe"
                            : "#38bdf8",
                      }}
                    >
                      {event.eventType}
                    </span>
                  </td>
                  <td style={{ padding: "12px 16px", fontFamily: "var(--font-mono)" }}>
                    {event.actor}
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <span
                      className="code-inline"
                      style={{ fontSize: "0.6875rem" }}
                      title={`Hash: ${event.hash}\nPrev: ${event.prevHash}`}
                    >
                      {event.hash.slice(0, 16)}…
                    </span>
                  </td>
                  <td style={{ padding: "12px 16px", color: "var(--text-secondary)" }}>
                    <span className="code-inline" style={{ fontSize: "0.6875rem" }}>
                      {JSON.stringify(event.payload).slice(0, 48)}…
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
          Showing records {fromSeq} to {fromSeq + auditData.events.length - 1} of{" "}
          {auditData.total}
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          {fromSeq > 1 && (
            <Link
              href={`/audit?from_seq=${Math.max(1, fromSeq - limit)}&limit=${limit}`}
              className="btn btn-secondary"
              style={{ fontSize: "0.8125rem", padding: "6px 12px" }}
            >
              ← Previous
            </Link>
          )}

          {auditData.hasMore && (
            <Link
              href={`/audit?from_seq=${fromSeq + limit}&limit=${limit}`}
              className="btn btn-secondary"
              style={{ fontSize: "0.8125rem", padding: "6px 12px" }}
            >
              Next →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
