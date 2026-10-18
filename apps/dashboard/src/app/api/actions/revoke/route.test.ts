import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  createSessionToken,
  generateCsrfToken,
  getDevSessionUser,
} from "@/lib/auth";
import { controlApiClient } from "@/lib/api";

describe("API Route: /api/actions/revoke", () => {
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
    const req = new NextRequest("http://localhost:3000/api/actions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaseId: "lease-1", reason: "Test" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 when user has viewer role", async () => {
    const viewer = getDevSessionUser("viewer");
    const sessionToken = await createSessionToken(viewer, testSecret);
    const csrfToken = await generateCsrfToken(viewer.id, testSecret);

    const req = new NextRequest("http://localhost:3000/api/actions/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}`,
        "x-synapse-csrf": csrfToken,
      },
      body: JSON.stringify({ leaseId: "lease-1", reason: "Test" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("FORBIDDEN");
  });

  it("returns 403 when CSRF token is missing", async () => {
    const operator = getDevSessionUser("operator");
    const sessionToken = await createSessionToken(operator, testSecret);

    const req = new NextRequest("http://localhost:3000/api/actions/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}`,
      },
      body: JSON.stringify({ leaseId: "lease-1", reason: "Test" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("CSRF_FORBIDDEN");
  });

  it("returns 403 when synapse_csrf cookie is sent but x-synapse-csrf header is missing (CSRF bypass regression)", async () => {
    const operator = getDevSessionUser("operator");
    const sessionToken = await createSessionToken(operator, testSecret);
    const csrfToken = await generateCsrfToken(operator.id, testSecret);

    const req = new NextRequest("http://localhost:3000/api/actions/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}; synapse_csrf=${csrfToken}`,
      },
      body: JSON.stringify({ leaseId: "lease-1", reason: "Test" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("CSRF_FORBIDDEN");
  });

  it("returns 400 when missing required fields (reason or leaseId)", async () => {
    const operator = getDevSessionUser("operator");
    const sessionToken = await createSessionToken(operator, testSecret);
    const csrfToken = await generateCsrfToken(operator.id, testSecret);

    const req = new NextRequest("http://localhost:3000/api/actions/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}`,
        "x-synapse-csrf": csrfToken,
      },
      body: JSON.stringify({ leaseId: "lease-1" }), // missing reason
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("INVALID_REQUEST");
  });

  it("returns 400 in production when signed envelope is not provided (Invariant 2)", async () => {
    setNodeEnv("production");
    const operator = getDevSessionUser("operator");
    const sessionToken = await createSessionToken(operator, testSecret);
    const csrfToken = await generateCsrfToken(operator.id, testSecret);

    const req = new NextRequest("http://localhost:3000/api/actions/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}`,
        "x-synapse-csrf": csrfToken,
      },
      body: JSON.stringify({
        leaseId: "lease-1",
        reason: "Incident mitigation",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("WORKSTATION_SIGNATURE_REQUIRED");
    expect(data.cliCommand).toContain("synapse lease revoke lease-1");
  });

  it("executes revocation when workstation-signed envelope is provided in production", async () => {
    setNodeEnv("production");
    const operator = getDevSessionUser("operator");
    const sessionToken = await createSessionToken(operator, testSecret);
    const csrfToken = await generateCsrfToken(operator.id, testSecret);

    vi.spyOn(controlApiClient, "revokeLease").mockResolvedValueOnce({
      lease_id: "lease-1",
      state: "REVOKED",
    });

    const signedEnvelope = {
      payload: {
        v: 1 as const,
        lease_id: "lease-1",
        reason: "Workstation verified",
        revoked_at: new Date().toISOString(),
        kid: "ops-key-1",
      },
      sig: "valid-ed25519-signature-hex",
    };

    const req = new NextRequest("http://localhost:3000/api/actions/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `synapse_session=${sessionToken}`,
        "x-synapse-csrf": csrfToken,
      },
      body: JSON.stringify({
        leaseId: "lease-1",
        reason: "Workstation verified",
        envelope: signedEnvelope,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.state).toBe("REVOKED");
  });
});
