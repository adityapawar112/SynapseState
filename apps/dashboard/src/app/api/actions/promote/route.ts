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
      { error: "UNAUTHORIZED", message: "Session required to promote emergency lease to Git" },
      { status: 401 }
    );
  }

  // 2. CSRF Token Validation — Strictly require x-synapse-csrf header
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
  if (!hasRolePermission(user.role, "promote")) {
    return NextResponse.json(
      {
        error: "FORBIDDEN",
        message: `Role "${user.role}" is not authorized to promote emergency leases to Git. Operator or Admin required.`,
      },
      { status: 403 }
    );
  }

  // 4. Payload validation
  const body = (await request.json().catch(() => ({}))) as {
    leaseId?: string;
    env?: string;
  };

  if (!body.leaseId) {
    return NextResponse.json(
      { error: "INVALID_REQUEST", message: "leaseId is required" },
      { status: 400 }
    );
  }

  // 5. Development simulation fallback (strictly blocked in production)
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.SYNAPSE_MOCK_PROMOTE === "true"
  ) {
    void controlApiClient.recordAuditEvent({
      actor: user.login,
      eventType: "DASHBOARD_PROMOTE_TRIGGERED",
      payload: { leaseId: body.leaseId, env: body.env, simulated: true },
    });

    return NextResponse.json({
      success: true,
      leaseId: body.leaseId,
      prUrl: `https://github.com/adityapawar112/SynapseState/pull/mock-${body.leaseId.slice(0, 8)}`,
      branch: `synapse/promote-lease-${body.leaseId}`,
      actor: user.login,
      simulated: true,
      note: "Simulated promotion in local development environment",
    });
  }

  // 6. Execute promotion via Control API
  try {
    const result = await controlApiClient.promoteLease(body.leaseId, {
      env: body.env,
      actor: user.login,
    });

    void controlApiClient.recordAuditEvent({
      actor: user.login,
      eventType: "DASHBOARD_PROMOTE_TRIGGERED",
      payload: {
        leaseId: body.leaseId,
        env: body.env,
        prUrl: result.pr_url,
        branch: result.branch,
      },
    });

    return NextResponse.json({
      success: true,
      leaseId: body.leaseId,
      prUrl: result.pr_url,
      branch: result.branch,
      actor: user.login,
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    const existingPrUrl = (err as { existingPrUrl?: string })?.existingPrUrl;
    const message = err instanceof Error ? err.message : "Control API rejected promotion";

    if (code === "STALE_PR_CONFLICT") {
      return NextResponse.json(
        {
          error: "STALE_PR_CONFLICT",
          message,
          existingPrUrl: existingPrUrl || undefined,
        },
        { status: 409 }
      );
    }


    return NextResponse.json(
      {
        error: "PROMOTION_FAILED",
        message,
      },
      { status: 502 }
    );
  }
}
