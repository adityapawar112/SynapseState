import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  verifySessionToken,
  validateCsrfToken,
  getDevSessionUser,
  getSessionSecret,
} from "@/lib/auth";
import { hasRolePermission } from "@/lib/domain";
import { controlApiClient } from "@/lib/api";

export async function POST(request: NextRequest) {
  const secret = getSessionSecret();

  // 1. Session check
  const cookie = request.cookies.get("synapse_session")?.value;
  let user = cookie ? await verifySessionToken(cookie, secret) : null;

  if (
    !user &&
    process.env.NODE_ENV !== "production" &&
    process.env.SYNAPSE_DEV_AUTH === "true"
  ) {
    user = getDevSessionUser("operator");
  }

  if (!user) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "Session required to revoke emergency lease" },
      { status: 401 }
    );
  }

  // 2. CSRF Token Validation — Strictly require header for double-submit protection
  const csrfToken = request.headers.get("x-synapse-csrf");

  const isDevAuth =
    process.env.NODE_ENV !== "production" &&
    process.env.SYNAPSE_DEV_AUTH === "true";

  if (!isDevAuth) {
    const isCsrfValid = csrfToken
      ? await validateCsrfToken(csrfToken, user.id, secret)
      : false;

    if (!isCsrfValid) {
      return NextResponse.json(
        {
          error: "CSRF_FORBIDDEN",
          message: "Valid x-synapse-csrf token header is required for mutation requests",
        },
        { status: 403 }
      );
    }
  }

  // 3. RBAC permission check
  if (!hasRolePermission(user.role, "revoke")) {
    return NextResponse.json(
      {
        error: "FORBIDDEN",
        message: `Role "${user.role}" is not authorized to revoke emergency leases. Operator or Admin required.`,
      },
      { status: 403 }
    );
  }

  // 4. Payload validation
  const body = (await request.json().catch(() => ({}))) as {
    leaseId?: string;
    flagKey?: string;
    env?: string;
    reason?: string;
    kid?: string;
    envelope?: {
      payload: {
        v: 1;
        lease_id: string;
        reason: string;
        revoked_at: string;
        kid: string;
      };
      sig: string;
    };
  };

  if (!body.leaseId || !body.reason) {
    return NextResponse.json(
      { error: "INVALID_REQUEST", message: "leaseId and reason are required" },
      { status: 400 }
    );
  }

  // 5. Invariant 2 Enforcement: Signed Envelope Handling
  // In production, the web tier never holds Ed25519 signing keys.
  // The client must either provide a workstation-signed envelope or execute via CLI.
  let revocationEnvelope = body.envelope;

  if (!revocationEnvelope) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        {
          error: "WORKSTATION_SIGNATURE_REQUIRED",
          message:
            "Air-Gapped Trust Root Invariant 2: Web tier does not store Ed25519 private keys. In production, run 'synapse lease revoke <id>' from your authorized workstation or provide a signed 'envelope'.",
          cliCommand: `synapse lease revoke ${body.leaseId} --reason "${body.reason}"`,
        },
        { status: 400 }
      );
    }

    // Development fallback mock envelope
    revocationEnvelope = {
      payload: {
        v: 1 as const,
        lease_id: body.leaseId,
        reason: body.reason,
        revoked_at: new Date().toISOString(),
        kid: body.kid || "ops-emergency-key",
      },
      sig: "dashboard-dev-simulated-revocation-token",
    };
  }

  try {
    const result = await controlApiClient.revokeLease(body.leaseId, revocationEnvelope);

    void controlApiClient.recordAuditEvent({
      actor: user.login,
      eventType: "DASHBOARD_REVOKE_TRIGGERED",
      payload: { leaseId: body.leaseId, reason: body.reason },
    });

    return NextResponse.json({
      success: true,
      leaseId: body.leaseId,
      state: result.state,
      actor: user.login,
    });
  } catch (err: unknown) {
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.SYNAPSE_MOCK_REVOKE === "true"
    ) {
      void controlApiClient.recordAuditEvent({
        actor: user.login,
        eventType: "DASHBOARD_REVOKE_TRIGGERED",
        payload: { leaseId: body.leaseId, reason: body.reason, simulated: true },
      });

      return NextResponse.json({
        success: true,
        leaseId: body.leaseId,
        state: "REVOKED",
        actor: user.login,
        simulated: true,
        note: "Simulated revocation in local development environment",
      });
    }


    return NextResponse.json(
      {
        error: "REVOCATION_FAILED",
        message: err instanceof Error ? err.message : "Control API rejected revocation",
      },
      { status: 502 }
    );
  }
}
