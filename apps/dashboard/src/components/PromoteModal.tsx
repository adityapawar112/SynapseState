"use client";

import React, { useState } from "react";
import type { ActiveLeaseView, UserRole } from "@/lib/types";
import { hasRolePermission } from "@/lib/domain";
import { LuX, LuCircleCheck, LuTriangleAlert, LuGitPullRequest, LuExternalLink, LuGitBranch } from "react-icons/lu";

interface PromoteModalProps {
  lease: ActiveLeaseView;
  userRole: UserRole;
  onClose: () => void;
  onPromoted?: (prUrl: string) => void;
}

export function PromoteModal({
  lease,
  userRole,
  onClose,
  onPromoted,
}: PromoteModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingPrUrl, setExistingPrUrl] = useState<string | null>(lease.promotePrUrl || null);
  const [promotedResult, setPromotedResult] = useState<{
    prUrl: string;
    branch: string;
  } | null>(null);

  const canPromote = hasRolePermission(userRole, "promote");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canPromote) {
      setError(`Role "${userRole}" is not authorized to promote emergency leases to Git.`);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const csrfCookie = typeof document !== "undefined"
        ? document.cookie
            .split("; ")
            .find((row) => row.startsWith("synapse_csrf="))
            ?.split("=")[1]
        : undefined;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (csrfCookie) {
        try {
          headers["x-synapse-csrf"] = decodeURIComponent(csrfCookie);
        } catch {
          headers["x-synapse-csrf"] = csrfCookie;
        }
      }

      const res = await fetch("/api/actions/promote", {
        method: "POST",
        headers,
        body: JSON.stringify({
          leaseId: lease.leaseId,
          env: lease.env,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.error === "STALE_PR_CONFLICT" && data.existingPrUrl) {
          setExistingPrUrl(data.existingPrUrl);
        }
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }

      setPromotedResult({
        prUrl: data.prUrl,
        branch: data.branch,
      });

      if (onPromoted) {
        onPromoted(data.prUrl);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to promote lease");
    } finally {
      setIsSubmitting(false);
    }
  };

  const cliCommand = `synapse promote --lease-id ${lease.leaseId}`;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="promote-modal-title"
    >
      <div
        className="card-hairline"
        style={{
          width: "100%",
          maxWidth: "560px",
          backgroundColor: "var(--color-canvas)",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
          position: "relative",
          margin: "16px",
        }}
      >
        {/* Modal Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "24px",
                  height: "24px",
                  borderRadius: "var(--radius-xs)",
                  backgroundColor: "var(--color-storage)",
                  color: "#ffffff",
                }}
              >
                <LuGitPullRequest size={14} />
              </span>
              <h2
                id="promote-modal-title"
                style={{
                  fontSize: "18px",
                  fontWeight: 600,
                  letterSpacing: "-0.3px",
                  color: "var(--color-ink)",
                }}
              >
                Promote Override to Git
              </h2>
            </div>
            <p style={{ fontSize: "13px", color: "var(--color-muted)", margin: 0 }}>
              Initiate Dual-Control reconciliation by opening a Draft Pull Request against Git.
            </p>
          </div>

          <button
            id="close-promote-modal-btn"
            type="button"
            className="btn btn-secondary"
            style={{ width: "32px", height: "32px", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={onClose}
            aria-label="Close dialog"
          >
            <LuX size={16} />
          </button>
        </div>

        {/* Dual-Control Invariant Notice */}
        <div
          style={{
            padding: "12px 14px",
            borderRadius: "var(--radius-xs)",
            backgroundColor: "var(--color-cream)",
            border: "1px solid var(--color-hairline)",
            fontSize: "12px",
            color: "var(--color-ink-soft)",
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: "var(--color-ink)" }}>Dual-Control Invariant 4:</strong> This action
          creates branch <span className="code-inline">{`synapse/promote-lease-${lease.leaseId.slice(0, 8)}…`}</span> and
          opens a Draft PR targeting <span className="code-inline">{`flags/${lease.env}/${lease.flagKey}.yaml`}</span>.
          Human peer review and merge of that PR serves as mandatory secondary approval to make the override permanent.
        </div>

        {/* Override Metadata Grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "10px",
            padding: "12px 14px",
            borderRadius: "var(--radius-xs)",
            backgroundColor: "var(--color-cream)",
            border: "1px solid var(--color-hairline)",
            fontSize: "12px",
          }}
        >
          <div>
            <span className="mono-caption" style={{ color: "var(--color-muted)" }}>Target Flag</span>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--color-ink)", marginTop: "2px" }}>
              {lease.flagKey}
            </div>
          </div>

          <div>
            <span className="mono-caption" style={{ color: "var(--color-muted)" }}>Environment</span>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--color-ink)", marginTop: "2px" }}>
              {lease.env}
            </div>
          </div>

          <div>
            <span className="mono-caption" style={{ color: "var(--color-muted)" }}>Forced Variant Value</span>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--color-storage)", marginTop: "2px" }}>
              {JSON.stringify(lease.value)}
            </div>
          </div>

          <div>
            <span className="mono-caption" style={{ color: "var(--color-muted)" }}>Emergency Lease ID</span>
            <div style={{ fontFamily: "var(--font-mono)", color: "var(--color-ink-soft)", marginTop: "2px" }}>
              {lease.leaseId}
            </div>
          </div>
        </div>

        {/* Success State */}
        {promotedResult && (
          <div
            id="promote-success-banner"
            style={{
              padding: "14px 16px",
              borderRadius: "var(--radius-xs)",
              backgroundColor: "rgba(0, 189, 125, 0.1)",
              border: "1px solid var(--color-storage)",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-storage)", fontWeight: 600, fontSize: "14px" }}>
              <LuCircleCheck size={18} />
              <span>Draft Pull Request Created Successfully</span>
            </div>

            <div style={{ fontSize: "13px", color: "var(--color-ink)", lineHeight: 1.4 }}>
              Branch <span className="code-inline">{promotedResult.branch}</span> has been pushed and a Draft Pull Request is open in GitHub.
            </div>

            <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
              <a
                id="view-pr-link"
                href={promotedResult.prUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary"
                style={{
                  backgroundColor: "var(--color-storage)",
                  borderColor: "var(--color-storage)",
                  color: "#ffffff",
                  fontSize: "13px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span>View Draft PR on GitHub</span>
                <LuExternalLink size={14} />
              </a>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
                style={{ fontSize: "13px" }}
              >
                Done
              </button>
            </div>
          </div>
        )}

        {/* Existing PR Conflict State */}
        {!promotedResult && existingPrUrl && (
          <div
            id="existing-pr-banner"
            style={{
              padding: "12px 14px",
              borderRadius: "var(--radius-xs)",
              backgroundColor: "rgba(255, 94, 31, 0.08)",
              border: "1px solid var(--color-kumo-brand)",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              fontSize: "13px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--color-kumo-brand)", fontWeight: 600 }}>
              <LuTriangleAlert size={16} />
              <span>Promotion Pull Request Already Exists</span>
            </div>
            <div style={{ color: "var(--color-ink-soft)" }}>
              A promotion Pull Request is already open for this override in Git.
            </div>
            <div>
              <a
                href={existingPrUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary"
                style={{ fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "6px", marginTop: "4px" }}
              >
                <span>Open Existing PR: {existingPrUrl}</span>
                <LuExternalLink size={12} />
              </a>
            </div>
          </div>
        )}

        {/* Error Banner */}
        {error && !existingPrUrl && (
          <div
            id="promote-error-banner"
            style={{
              padding: "10px 14px",
              borderRadius: "var(--radius-xs)",
              backgroundColor: "var(--color-canvas)",
              border: "1px solid var(--color-under-attack)",
              color: "var(--color-under-attack)",
              fontSize: "13px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <LuTriangleAlert size={16} />
            <span>{error}</span>
          </div>
        )}

        {/* Modal Form Actions */}
        {!promotedResult && (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                id="cancel-promote-btn"
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
                disabled={isSubmitting}
              >
                Cancel
              </button>

              <button
                id="submit-promote-btn"
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting || !canPromote}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  backgroundColor: "var(--color-storage)",
                  borderColor: "var(--color-storage)",
                  color: "#ffffff",
                }}
              >
                <LuGitBranch size={15} />
                <span>{isSubmitting ? "Opening Draft PR…" : "Create Promotion PR"}</span>
              </button>
            </div>
          </form>
        )}

        {/* CLI Alternative Reference */}
        <div
          style={{
            borderTop: "1px solid var(--color-hairline)",
            paddingTop: "12px",
            fontSize: "12px",
            color: "var(--color-muted)",
          }}
        >
          <span>CLI Alternative: </span>
          <span className="code-inline" style={{ userSelect: "all" }}>
            {cliCommand}
          </span>
        </div>
      </div>
    </div>
  );
}
