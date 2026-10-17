"use client";

import React, { useState } from "react";
import type { ActiveLeaseView, UserRole } from "@/lib/types";
import { hasRolePermission } from "@/lib/domain";
import { LuX, LuCircleCheck, LuTriangleAlert } from "react-icons/lu";

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
        className="card-hairline"
        style={{
          width: "100%",
          maxWidth: "540px",
          backgroundColor: "var(--color-canvas)",
          padding: "32px",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
          boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.05)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <span className="mono-caption" style={{ color: "var(--color-under-attack)" }}>
              EMERGENCY ACTION
            </span>
            <h2
              id="revoke-modal-title"
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "20px",
                fontWeight: 500,
                color: "var(--color-ink)",
                letterSpacing: "-0.4px",
                marginTop: "2px",
              }}
            >
              Revoke Emergency Break-Glass Lease
            </h2>
          </div>
          <button
            id="revoke-modal-close-btn"
            type="button"
            className="btn btn-secondary"
            style={{ padding: "0", fontSize: "14px", height: "32px", width: "32px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            onClick={onClose}
            aria-label="Close modal"
          >
            <LuX size={15} />
          </button>
        </div>

        {/* Safety Boundary Notice */}
        <div
          style={{
            padding: "12px 14px",
            borderRadius: "var(--radius-xs)",
            backgroundColor: "#fff1f2",
            border: "1px solid #fecdd3",
            fontSize: "13px",
            color: "var(--color-under-attack)",
            lineHeight: 1.45,
          }}
        >
          <strong>Safety Invariant Notice:</strong> Revoking this lease immediately restores
          normal in-process flag evaluation to the delegate OpenFeature provider across all
          connected application workloads.
        </div>

        {revokedSuccess ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px", textAlign: "center", padding: "16px 0" }}>
            <div style={{ display: "flex", justifyContent: "center", color: "var(--color-ai)" }}>
              <LuCircleCheck size={42} />
            </div>
            <h3 style={{ fontSize: "18px", color: "var(--color-ai)", fontWeight: 500 }}>
              Lease Revoked Successfully
            </h3>
            <p style={{ fontSize: "14px", color: "var(--color-muted)", lineHeight: 1.5 }}>
              The revocation has been committed to the audit ledger and broadcast to all long-polling SDKs.
            </p>
            <button
              id="revoke-modal-done-btn"
              type="button"
              className="btn btn-pill-brand"
              style={{ alignSelf: "center", marginTop: "8px" }}
              onClick={onClose}
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div>
              <label className="mono-caption" style={{ display: "block", color: "var(--color-muted)", marginBottom: "4px" }}>
                Target Flag & Lease ID
              </label>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "14px", color: "var(--color-ink)" }}>
                <strong>{lease.flagKey}</strong> <span style={{ color: "var(--color-muted)" }}>({lease.leaseId})</span>
              </div>
            </div>

            <div>
              <label
                htmlFor="revoke-reason-input"
                className="mono-caption"
                style={{ display: "block", color: "var(--color-muted)", marginBottom: "4px" }}
              >
                Revocation Reason (Audit Log Entry)
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
                  padding: "10px 12px",
                  borderRadius: "var(--radius-xs)",
                  backgroundColor: "var(--color-canvas)",
                  border: "1px solid var(--color-hairline)",
                  color: "var(--color-ink)",
                  fontFamily: "var(--font-sans)",
                  fontSize: "14px",
                  resize: "vertical",
                  outline: "none",
                }}
              />
            </div>

            <div>
              <label
                htmlFor="revoke-kid-input"
                className="mono-caption"
                style={{ display: "block", color: "var(--color-muted)", marginBottom: "4px" }}
              >
                Operator Key ID (KID)
              </label>
              <input
                id="revoke-kid-input"
                type="text"
                required
                className="text-input"
                style={{ width: "100%", fontFamily: "var(--font-mono)" }}
                value={operatorKid}
                onChange={(e) => setOperatorKid(e.target.value)}
              />
            </div>

            {/* Optional Pre-Signed Envelope Input for Air-Gapped Verification */}
            <div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: "12px", height: "30px", padding: "2px 8px" }}
                onClick={() => setShowEnvelopeInput(!showEnvelopeInput)}
              >
                {showEnvelopeInput ? "Hide Signed Envelope" : "Attach Workstation-Signed Envelope (Prod)"}
              </button>
              {showEnvelopeInput && (
                <div style={{ marginTop: "8px" }}>
                  <label
                    htmlFor="revoke-envelope-input"
                    className="mono-caption"
                    style={{ display: "block", color: "var(--color-muted)", marginBottom: "4px" }}
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
                      padding: "8px 10px",
                      borderRadius: "var(--radius-xs)",
                      backgroundColor: "var(--color-canvas)",
                      border: "1px solid var(--color-hairline)",
                      color: "var(--color-ink)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      outline: "none",
                    }}
                  />
                </div>
              )}
            </div>

            {/* Terminal Command Alternative */}
            <div>
              <label className="mono-caption" style={{ display: "block", color: "var(--color-muted)", marginBottom: "4px" }}>
                Workstation CLI Command (Air-Gapped Signed Alternative):
              </label>
              <code className="code-inline" style={{ display: "block", padding: "8px 10px", overflowX: "auto" }}>
                {cliCommand}
              </code>
            </div>

            {error && (
              <div style={{ color: "var(--color-under-attack)", fontSize: "13px", padding: "8px 12px", borderRadius: "var(--radius-xs)", backgroundColor: "#fff1f2", border: "1px solid #fecdd3" }}>
                {error}
              </div>
            )}

            {!canRevoke && (
              <div style={{ color: "var(--color-kumo-brand-dark)", fontSize: "13px", padding: "8px 12px", borderRadius: "var(--radius-xs)", backgroundColor: "rgba(255, 94, 31, 0.08)", border: "1px solid rgba(255, 94, 31, 0.25)", display: "flex", alignItems: "center", gap: "8px" }}>
                <LuTriangleAlert size={15} style={{ flexShrink: 0 }} />
                <span>
                  Your current role (<strong>{userRole}</strong>) is read-only. Only <strong>operator</strong> or <strong>admin</strong> can execute revocations.
                </span>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
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
