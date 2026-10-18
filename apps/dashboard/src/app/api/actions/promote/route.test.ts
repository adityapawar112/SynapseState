import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  createSessionToken,
  generateCsrfToken,
  getDevSessionUser,
} from "@/lib/auth";
import { controlApiClient } from "@/lib/api";

describe("API Route: POST /api/actions/promote (PR 25)", () => {
  const testSecret = "test-session-secret-key-at-least-32-chars-long";
  const origEnv = process.env.NODE_ENV;
  const origDevAuth = process.env.SYNAPSE_DEV_AUTH;
  const origSecret = process.env.SESSION_SECRET;

  const setNodeEnv = (val: string | undefined) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = val;
  };

  beforeEach(() => {
    process.env.SESSION_SECRET = testSecret;
    delete process.env.SYNAPSE_DEV_AUTH;
    setNodeEnv("development");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setNodeEnv(origEnv);
    if (origDevAuth !== undefined) process.env.SYNAPSE_DEV_AUTH = origDevAuth;
    else delete process.env.SYNAPSE_DEV_AUTH;
    if (origSecret !== undefined) process.env.SESSION_SECRET = origSecret;
    else delete process.env.SESSION_SECRET;
  });

  it("returns 401 when request has no session", async () => {
    setNodeEnv("production");
    const req = new NextRequest("http://localhost:3000/api/actions/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaseId: "01J9X57YTRPQ8A7F4E12345678", env: "production" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 when user has viewer role", async () => {
    const viewer = getDevSessionUser("viewer");
    const sessionToken = await createSessionToken(viewer, testSecret);
    const csrfToken = await generateCsrfToken(viewer.id, testSecret);

    const req = new NextRequest("http://localhost:3000/api/actions/promote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}`,
        "x-synapse-csrf": csrfToken,
      },
      body: JSON.stringify({ leaseId: "01J9X57YTRPQ8A7F4E12345678", env: "production" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("FORBIDDEN");
  });

  it("returns 403 when CSRF token is missing", async () => {
    const operator = getDevSessionUser("operator");
    const sessionToken = await createSessionToken(operator, testSecret);

    const req = new NextRequest("http://localhost:3000/api/actions/promote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}`,
      },
      body: JSON.stringify({ leaseId: "01J9X57YTRPQ8A7F4E12345678", env: "production" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("CSRF_FORBIDDEN");
  });

  it("returns 400 when leaseId is missing", async () => {
    const operator = getDevSessionUser("operator");
    const sessionToken = await createSessionToken(operator, testSecret);
    const csrfToken = await generateCsrfToken(operator.id, testSecret);

    const req = new NextRequest("http://localhost:3000/api/actions/promote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}`,
        "x-synapse-csrf": csrfToken,
      },
      body: JSON.stringify({ env: "production" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("INVALID_REQUEST");
  });

  it("promotes lease via controlApiClient, records DASHBOARD_PROMOTE_TRIGGERED, and returns PR details", async () => {
    const operator = getDevSessionUser("operator");
    const sessionToken = await createSessionToken(operator, testSecret);
    const csrfToken = await generateCsrfToken(operator.id, testSecret);

    const promoteSpy = vi.spyOn(controlApiClient, "promoteLease").mockResolvedValueOnce({
      lease_id: "01J9X57YTRPQ8A7F4E12345678",
      pr_url: "https://github.com/adityapawar112/SynapseState/pull/42",
      branch: "synapse/promote-lease-01J9X57YTRPQ8A7F4E12345678",
    });

    const auditSpy = vi.spyOn(controlApiClient, "recordAuditEvent").mockResolvedValueOnce(true);

    const req = new NextRequest("http://localhost:3000/api/actions/promote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}`,
        "x-synapse-csrf": csrfToken,
      },
      body: JSON.stringify({
        leaseId: "01J9X57YTRPQ8A7F4E12345678",
        env: "production",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.leaseId).toBe("01J9X57YTRPQ8A7F4E12345678");
    expect(data.prUrl).toBe("https://github.com/adityapawar112/SynapseState/pull/42");
    expect(data.branch).toBe("synapse/promote-lease-01J9X57YTRPQ8A7F4E12345678");
    expect(data.actor).toBe(operator.login);

    expect(promoteSpy).toHaveBeenCalledWith("01J9X57YTRPQ8A7F4E12345678", {
      env: "production",
      actor: operator.login,
    });

    expect(auditSpy).toHaveBeenCalledWith({
      actor: operator.login,
      eventType: "DASHBOARD_PROMOTE_TRIGGERED",
      payload: expect.objectContaining({
        leaseId: "01J9X57YTRPQ8A7F4E12345678",
        env: "production",
      }),
    });
  });

  it("returns 409 conflict when lease has existing PR or conflict", async () => {
    const operator = getDevSessionUser("operator");
    const sessionToken = await createSessionToken(operator, testSecret);
    const csrfToken = await generateCsrfToken(operator.id, testSecret);

    const conflictErr = new Error("Conflict with existing PR");
    (conflictErr as unknown as { code?: string; existingPrUrl?: string }).code = "STALE_PR_CONFLICT";
    (conflictErr as unknown as { existingPrUrl?: string }).existingPrUrl =
      "https://github.com/adityapawar112/SynapseState/pull/10";

    vi.spyOn(controlApiClient, "promoteLease").mockRejectedValueOnce(conflictErr);

    const req = new NextRequest("http://localhost:3000/api/actions/promote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}`,
        "x-synapse-csrf": csrfToken,
      },
      body: JSON.stringify({
        leaseId: "01J9X57YTRPQ8A7F4E12345678",
        env: "production",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("STALE_PR_CONFLICT");
    expect(data.existingPrUrl).toBe("https://github.com/adityapawar112/SynapseState/pull/10");
  });

  it("supports simulated promotion when SYNAPSE_MOCK_PROMOTE=true in development", async () => {
    process.env.SYNAPSE_MOCK_PROMOTE = "true";
    const operator = getDevSessionUser("operator");
    const sessionToken = await createSessionToken(operator, testSecret);
    const csrfToken = await generateCsrfToken(operator.id, testSecret);

    vi.spyOn(controlApiClient, "promoteLease").mockRejectedValueOnce(
      new Error("Control API unreachable")
    );

    const req = new NextRequest("http://localhost:3000/api/actions/promote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}`,
        "x-synapse-csrf": csrfToken,
      },
      body: JSON.stringify({
        leaseId: "01J9X57YTRPQ8A7F4E12345678",
        env: "production",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.simulated).toBe(true);
    expect(data.prUrl).toContain("github.com");
  });
});
