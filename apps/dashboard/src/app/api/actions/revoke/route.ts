import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySessionToken, getDevSessionUser } from "@/lib/auth";
import { hasRolePermission } from "@/lib/domain";
import { controlApiClient } from "@/lib/api";

const SECRET =
  process.env.SESSION_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  "default-development-session-secret-min-32-chars-long";

export async function POST(request: NextRequest) {
  // 1. Session check
  const cookie = request.cookies.get("synapse_session")?.value;
  let user = cookie ? verifySessionToken(cookie, SECRET) : null;

  if (!user && process.env.NODE_ENV !== "production") {
    user = getDevSessionUser("operator");
  }

  if (!user) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "Session required to revoke emergency lease" },
      { status: 401 }
    );
  }

  // 2. RBAC permission check
  if (!hasRolePermission(user.role, "revoke")) {
    return NextResponse.json(
      {
        error: "FORBIDDEN",
        message: `Role "${user.role}" is not authorized to revoke emergency leases. Operator or Admin required.`,
      },
      { status: 403 }
    );
  }

  // 3. Payload validation
  const body = (await request.json().catch(() => ({}))) as {
    leaseId?: string;
    flagKey?: string;
    env?: string;
    reason?: string;
    kid?: string;
  };

  if (!body.leaseId || !body.reason) {
    return NextResponse.json(
      { error: "INVALID_REQUEST", message: "leaseId and reason are required" },
      { status: 400 }
    );
  }

  // 4. Construct Revocation Envelope
  const revocationEnvelope = {
    payload: {
      v: 1 as const,
      lease_id: body.leaseId,
      reason: body.reason,
      revoked_at: new Date().toISOString(),
      kid: body.kid || "ops-emergency-key",
    },
    sig: "dashboard-operator-revocation-token",
  };

  try {
    const result = await controlApiClient.revokeLease(body.leaseId, revocationEnvelope);
    return NextResponse.json({
      success: true,
      leaseId: body.leaseId,
      state: result.state,
      actor: user.login,
    });
  } catch (err: unknown) {
    // Fallback in case Control API is offline or returns error in dev
    if (process.env.NODE_ENV !== "production") {
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
