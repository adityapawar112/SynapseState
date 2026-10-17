import React from "react";
import Link from "next/link";
import { controlApiClient } from "@/lib/api";
import { verifyAuditLedgerChain } from "@/lib/domain";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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
    <div
      style={{
        maxWidth: "1280px",
        margin: "0 auto",
        padding: "40px 24px 64px 24px",
        display: "flex",
        flexDirection: "column",
        gap: "32px",
      }}
    >
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
          <span className="mono-caption" style={{ color: "var(--color-sase)" }}>
            CRYPTOGRAPHIC AUDIT TRAIL
          </span>
          <h1
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "36px",
              fontWeight: 500,
              letterSpacing: "-0.8px",
              color: "var(--color-ink)",
              marginTop: "2px",
            }}
          >
            Tamper-Evident Audit Ledger
          </h1>
          <p style={{ color: "var(--color-muted)", fontSize: "15px", marginTop: "4px" }}>
            Append-only single-writer hash chain sealed with SHA-256 and verified against signed external checkpoints.
          </p>
        </div>

        {/* Verification Status Badge */}
        <div
          id="audit-chain-status-badge"
          style={{
            padding: "8px 16px",
            borderRadius: "var(--radius-full)",
            backgroundColor: chainVerification.valid
              ? "rgba(0, 189, 125, 0.08)"
              : "#fee2e2",
            border: chainVerification.valid
              ? "1px solid rgba(0, 189, 125, 0.3)"
              : "1px solid #fecdd3",
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <span style={{ fontSize: "16px" }}>{chainVerification.valid ? "🛡️" : "⚠️"}</span>
          <div>
            <div
              className="mono-caption"
              style={{
                fontWeight: 600,
                color: chainVerification.valid ? "var(--color-ai)" : "var(--color-under-attack)",
              }}
            >
              {chainVerification.valid ? "Hash Chain Verified" : "Tampering Detected"}
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-muted)" }}>
              {chainVerification.valid
                ? "Cryptographic SHA-256 continuity unbroken"
                : `Sequence discontinuity at seq #${chainVerification.brokenAtSeq}`}
            </div>
          </div>
        </div>
      </div>

      {/* Latest Signed Checkpoint Card */}
      <Card
        style={{
          padding: "24px 28px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "20px",
        }}
      >
        <div>
          <div className="mono-caption" style={{ color: "var(--color-muted)" }}>
            Checkpoint Sequence
          </div>
          <div style={{ fontSize: "24px", fontWeight: 500, fontFamily: "var(--font-mono)", color: "var(--color-ink)", marginTop: "4px" }}>
            #{latestCheckpoint.checkpointSeq}
          </div>
        </div>

        <div>
          <div className="mono-caption" style={{ color: "var(--color-muted)" }}>
            Sealed Records Count
          </div>
          <div style={{ fontSize: "24px", fontWeight: 500, color: "var(--color-sase)", marginTop: "4px" }}>
            {latestCheckpoint.sealedCount.toLocaleString()}{" "}
            <span style={{ fontSize: "14px", color: "var(--color-muted)" }}>events</span>
          </div>
        </div>

        <div>
          <div className="mono-caption" style={{ color: "var(--color-muted)" }}>
            Sealed Checkpoint Root
          </div>
          <div
            className="code-inline"
            style={{
              fontSize: "12px",
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginTop: "6px",
            }}
            title={latestCheckpoint.checkpointHash}
          >
            {latestCheckpoint.checkpointHash}
          </div>
        </div>

        <div>
          <div className="mono-caption" style={{ color: "var(--color-muted)" }}>
            Checkpoint Timestamp
          </div>
          <div style={{ fontSize: "14px", color: "var(--color-ink)", marginTop: "6px" }}>
            {latestCheckpoint.timestamp
              ? new Date(latestCheckpoint.timestamp).toLocaleString()
              : "Genesis initial"}
          </div>
        </div>
      </Card>

      {/* Events Table in Hairline Card */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--color-hairline)",
                  backgroundColor: "var(--color-cream)",
                  textAlign: "left",
                }}
              >
                <th className="mono-caption" style={{ padding: "12px 18px", color: "var(--color-muted)" }}>Seq</th>
                <th className="mono-caption" style={{ padding: "12px 18px", color: "var(--color-muted)" }}>Timestamp</th>
                <th className="mono-caption" style={{ padding: "12px 18px", color: "var(--color-muted)" }}>Event Type</th>
                <th className="mono-caption" style={{ padding: "12px 18px", color: "var(--color-muted)" }}>Actor KID</th>
                <th className="mono-caption" style={{ padding: "12px 18px", color: "var(--color-muted)" }}>Event SHA-256 Hash</th>
                <th className="mono-caption" style={{ padding: "12px 18px", color: "var(--color-muted)" }}>Payload Details</th>
              </tr>
            </thead>
            <tbody>
              {auditData.events.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: "48px 24px", textAlign: "center", color: "var(--color-muted)" }}>
                    No sealed audit records found.
                  </td>
                </tr>
              ) : (
                auditData.events.map((event) => {
                  let eventBadgeVariant: "sase" | "storage" | "ai" | "default" = "sase";
                  if (event.eventType.includes("REVOKE")) eventBadgeVariant = "storage";
                  else if (event.eventType.includes("PROMOTE")) eventBadgeVariant = "ai";

                  return (
                    <tr
                      key={event.seq}
                      style={{
                        borderBottom: "1px solid var(--color-hairline)",
                        transition: "background-color 0.1s ease",
                      }}
                    >
                      <td style={{ padding: "14px 18px", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                        #{event.seq}
                      </td>
                      <td style={{ padding: "14px 18px", color: "var(--color-muted)" }}>
                        {new Date(event.ts).toLocaleTimeString()}
                      </td>
                      <td style={{ padding: "14px 18px" }}>
                        <Badge variant={eventBadgeVariant}>{event.eventType}</Badge>
                      </td>
                      <td style={{ padding: "14px 18px", fontFamily: "var(--font-mono)", fontSize: "12px" }}>
                        {event.actor}
                      </td>
                      <td style={{ padding: "14px 18px" }}>
                        <span
                          className="code-inline"
                          style={{ fontSize: "11px" }}
                          title={`Hash: ${event.hash}\nPrev: ${event.prevHash}`}
                        >
                          {event.hash.slice(0, 16)}…
                        </span>
                      </td>
                      <td style={{ padding: "14px 18px", color: "var(--color-ink-soft)" }}>
                        <span className="code-inline" style={{ fontSize: "11px" }}>
                          {JSON.stringify(event.payload).slice(0, 48)}…
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pagination Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div style={{ fontSize: "13px", color: "var(--color-muted)" }}>
          Showing records {fromSeq} to {fromSeq + auditData.events.length - 1} of{" "}
          <strong style={{ color: "var(--color-ink)" }}>{auditData.total}</strong>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          {fromSeq > 1 && (
            <Link
              href={`/audit?from_seq=${Math.max(1, fromSeq - limit)}&limit=${limit}`}
              className="btn btn-secondary"
              style={{ fontSize: "13px", height: "32px", padding: "4px 12px" }}
            >
              ← Previous
            </Link>
          )}

          {auditData.hasMore && (
            <Link
              href={`/audit?from_seq=${fromSeq + limit}&limit=${limit}`}
              className="btn btn-secondary"
              style={{ fontSize: "13px", height: "32px", padding: "4px 12px" }}
            >
              Next →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
