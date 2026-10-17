"use client";

import React, { useState } from "react";
import type { ActiveLeaseView, UserRole } from "@/lib/types";
import { hasRolePermission } from "@/lib/domain";

interface RevokeModalProps {
  lease: ActiveLeaseView;
  userRole: UserRole;
  onClose: () => void;
  onRevoked?: () => void;
}

export function RevokeModal({
  lease,
  userRole,
  onClose,
  onRevoked,
}: RevokeModalProps) {
  const [reason, setReason] = useState("");
  const [operatorKid, setOperatorKid] = useState(lease.kid || "ops-emergency-key");
  const [signedEnvelopeJson, setSignedEnvelopeJson] = useState("");
  const [showEnvelopeInput, setShowEnvelopeInput] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokedSuccess, setRevokedSuccess] = useState(false);

  const canRevoke = hasRolePermission(userRole, "revoke");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Revocation reason is required for the tamper-evident audit ledger.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      let parsedEnvelope: unknown = undefined;
      if (signedEnvelopeJson.trim()) {
        try {
          parsedEnvelope = JSON.parse(signedEnvelopeJson.trim());
        } catch {
          throw new Error("Invalid signed envelope JSON format.");
        }
      }

      // Read CSRF token from browser cookie
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
        headers["x-synapse-csrf"] = decodeURIComponent(csrfCookie);
      }

      const res = await fetch("/api/actions/revoke", {
        method: "POST",
        headers,
        body: JSON.stringify({
          leaseId: lease.leaseId,
          flagKey: lease.flagKey,
          env: lease.env,
          reason: reason.trim(),
          kid: operatorKid.trim(),
          envelope: parsedEnvelope,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }

      setRevokedSuccess(true);
      if (onRevoked) {
        onRevoked();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to revoke lease");
    } finally {
      setIsSubmitting(false);
    }
  };

  const cliCommand = `synapse lease revoke ${lease.leaseId} --reason "${reason || "Incident resolved"}"`;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="revoke-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: "100%",
          maxWidth: "540px",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.7)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2
            id="revoke-modal-title"
            style={{ fontSize: "1.25rem", fontWeight: 700, color: "#f87171" }}
          >
            Revoke Emergency Break-Glass Lease
          </h2>
          <button
            id="revoke-modal-close-btn"
            type="button"
            className="btn btn-secondary"
            style={{ padding: "4px 8px", fontSize: "1rem" }}
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* Safety Boundary Notice */}
        <div
          style={{
            padding: "12px",
            borderRadius: "8px",
            backgroundColor: "rgba(244, 63, 94, 0.1)",
            border: "1px solid rgba(244, 63, 94, 0.25)",
            fontSize: "0.8125rem",
            color: "#fecdd3",
            lineHeight: 1.4,
          }}
        >
          <strong>Safety Invariant Notice:</strong> Revoking this lease immediately restores
          normal in-process flag evaluation to the delegate OpenFeature provider across all
          connected application workloads.
        </div>

        {revokedSuccess ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", textAlign: "center", padding: "16px 0" }}>
            <div style={{ fontSize: "2.5rem" }}>✅</div>
            <h3 style={{ fontSize: "1.125rem", color: "#34d399", fontWeight: 600 }}>
              Lease Revoked Successfully
            </h3>
            <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
              The revocation has been committed to the audit ledger and broadcast to all long-polling SDKs.
            </p>
            <button
              id="revoke-modal-done-btn"
              type="button"
              className="btn btn-primary"
              style={{ alignSelf: "center", marginTop: "8px" }}
              onClick={onClose}
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "4px" }}>
                Target Flag & Lease ID
              </label>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.875rem", color: "var(--text-primary)" }}>
                <strong>{lease.flagKey}</strong> ({lease.leaseId})
              </div>
            </div>

            <div>
              <label
                htmlFor="revoke-reason-input"
                style={{ display: "block", fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "4px" }}
              >
                Revocation Reason (Required for Audit Ledger)
              </label>
              <textarea
                id="revoke-reason-input"
                required
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Incident #4492 resolved: Payment gateway rollback verified"
                style={{
                  width: "100%",
                  padding: "10px",
                  borderRadius: "6px",
                  backgroundColor: "rgba(0, 0, 0, 0.3)",
                  border: "1px solid var(--border-subtle)",
                  color: "var(--text-primary)",
                  fontFamily: "var(--font-sans)",
                  fontSize: "0.875rem",
                  resize: "vertical",
                }}
              />
            </div>

            <div>
              <label
                htmlFor="revoke-kid-input"
                style={{ display: "block", fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "4px" }}
              >
                Operator Key ID (KID)
              </label>
              <input
                id="revoke-kid-input"
                type="text"
                required
                value={operatorKid}
                onChange={(e) => setOperatorKid(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: "6px",
                  backgroundColor: "rgba(0, 0, 0, 0.3)",
                  border: "1px solid var(--border-subtle)",
                  color: "var(--text-primary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.875rem",
                }}
              />
            </div>

            {/* Optional Pre-Signed Envelope Input for Air-Gapped Verification */}
            <div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: "0.75rem", padding: "4px 8px" }}
                onClick={() => setShowEnvelopeInput(!showEnvelopeInput)}
              >
                {showEnvelopeInput ? "Hide Signed Envelope" : "Attach Workstation-Signed Envelope (Prod)"}
              </button>
              {showEnvelopeInput && (
                <div style={{ marginTop: "8px" }}>
                  <label
                    htmlFor="revoke-envelope-input"
                    style={{ display: "block", fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: "4px" }}
                  >
                    Signed RevocationEnvelope JSON:
                  </label>
                  <textarea
                    id="revoke-envelope-input"
                    rows={3}
                    value={signedEnvelopeJson}
                    onChange={(e) => setSignedEnvelopeJson(e.target.value)}
                    placeholder='{"payload":{"v":1,"lease_id":"...","reason":"...","revoked_at":"...","kid":"..."},"sig":"..."}'
                    style={{
                      width: "100%",
                      padding: "8px",
                      borderRadius: "6px",
                      backgroundColor: "rgba(0, 0, 0, 0.3)",
                      border: "1px solid var(--border-subtle)",
                      color: "var(--text-primary)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.75rem",
                    }}
                  />
                </div>
              )}
            </div>

            {/* Terminal Command Alternative */}
            <div>
              <label style={{ display: "block", fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "4px" }}>
                Workstation CLI Command (Air-Gapped Signed Alternative):
              </label>
              <code className="code-inline" style={{ display: "block", padding: "8px", overflowX: "auto" }}>
                {cliCommand}
              </code>
            </div>

            {error && (
              <div style={{ color: "#f87171", fontSize: "0.8125rem", padding: "8px", borderRadius: "4px", backgroundColor: "rgba(248, 113, 113, 0.1)" }}>
                {error}
              </div>
            )}

            {!canRevoke && (
              <div style={{ color: "#fbbf24", fontSize: "0.8125rem" }}>
                ⚠️ Your current role (<strong>{userRole}</strong>) is read-only. Only <strong>operator</strong> or <strong>admin</strong> can execute revocations.
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "8px" }}>
              <button
                id="revoke-modal-cancel-btn"
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                id="revoke-modal-confirm-btn"
                type="submit"
                className="btn btn-danger"
                disabled={isSubmitting || !canRevoke || !reason.trim()}
              >
                {isSubmitting ? "Revoking..." : "Confirm Revocation"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
