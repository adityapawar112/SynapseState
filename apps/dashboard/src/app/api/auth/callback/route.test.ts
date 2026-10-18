import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { verifySessionToken } from "@/lib/auth";
import { controlApiClient } from "@/lib/api";

describe("API Route: GET /api/auth/callback", () => {
  const origEnv = { ...process.env };
  const mockSecret = "test-session-secret-at-least-32-chars-long";

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = mockSecret;
    process.env.GITHUB_CLIENT_ID = "mock-client-id";
    process.env.GITHUB_CLIENT_SECRET = "mock-client-secret";
    process.env.SYNAPSE_ADMIN_USERS = "admin-alice";
    process.env.SYNAPSE_ADMIN_TEAMS = "platform-admins";
    process.env.SYNAPSE_OPERATOR_TEAMS = "sre-ops,incident-responders";
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  it("redirects to /login?error=invalid_oauth_state when code or state is missing", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/callback");
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toContain("/login?error=invalid_oauth_state");
  });

  it("redirects to /login?error=invalid_oauth_state when state cookie does not match query state", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/auth/callback?code=mock-code&state=state-foo",
      {
        headers: {
          cookie: "synapse_oauth_state=state-bar",
        },
      }
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toContain("/login?error=invalid_oauth_state");
  });

  it("redirects to /login?error=github_oauth_not_configured when client secret is missing", async () => {
    delete process.env.GITHUB_CLIENT_SECRET;

    const req = new NextRequest(
      "http://localhost:3000/api/auth/callback?code=mock-code&state=matching-state",
      {
        headers: {
          cookie: "synapse_oauth_state=matching-state",
        },
      }
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toContain("/login?error=github_oauth_not_configured");
  });

  it("redirects to /login?error=oauth_exchange_failed when token exchange returns error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "bad_verification_code" }),
    } as Response);

    const req = new NextRequest(
      "http://localhost:3000/api/auth/callback?code=bad-code&state=matching-state",
      {
        headers: {
          cookie: "synapse_oauth_state=matching-state",
        },
      }
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toContain("/login?error=oauth_exchange_failed");
  });

  it("exchanges code, resolves operator role from teams, sets session and csrf cookies, and logs DASHBOARD_LOGIN", async () => {
    const mockAccessToken = "gho_mock_access_token_123";
    const mockUser = {
      id: 12345,
      login: "bob-sre",
      name: "Bob SRE",
      email: "bob@example.com",
      avatar_url: "https://avatars.githubusercontent.com/u/12345",
    };
    const mockTeams = [{ slug: "incident-responders", name: "Incident Responders" }];

    const auditSpy = vi.spyOn(controlApiClient, "recordAuditEvent").mockResolvedValue(true);

    vi.spyOn(globalThis, "fetch")
      // 1. Token exchange
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: mockAccessToken, token_type: "bearer" }),
      } as Response)
      // 2. User profile
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockUser,
      } as Response)
      // 3. User teams
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockTeams,
      } as Response)
      // 4. User orgs
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      } as Response);

    const req = new NextRequest(
      "http://localhost:3000/api/auth/callback?code=valid-code&state=matching-state",
      {
        headers: {
          cookie: "synapse_oauth_state=matching-state",
        },
      }
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBe("http://localhost:3000/");

    // Session cookie verified
    const sessionCookie = res.cookies.get("synapse_session");
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);

    const sessionUser = await verifySessionToken(sessionCookie!.value, mockSecret);
    expect(sessionUser).not.toBeNull();
    expect(sessionUser?.login).toBe("bob-sre");
    expect(sessionUser?.role).toBe("operator"); // mapped from incident-responders team!
    expect(sessionUser?.teams).toContain("incident-responders");

    // CSRF cookie
    const csrfCookie = res.cookies.get("synapse_csrf");
    expect(csrfCookie).toBeDefined();

    // OAuth state cookie cleared
    const deletedState = res.cookies.get("synapse_oauth_state");
    expect(deletedState?.value).toBe("");

    // Audit event recorded
    expect(auditSpy).toHaveBeenCalledWith({
      actor: "bob-sre",
      eventType: "DASHBOARD_LOGIN",
      payload: expect.objectContaining({
        role: "operator",
      }),
    });
  });

  it("resolves admin role when user matches SYNAPSE_ADMIN_USERS", async () => {
    const mockUser = {
      id: 99999,
      login: "admin-alice",
      name: "Alice Admin",
      email: "alice@example.com",
    };

    vi.spyOn(controlApiClient, "recordAuditEvent").mockResolvedValue(true);

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "gho_admin_token" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockUser,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      } as Response);

    const req = new NextRequest(
      "http://localhost:3000/api/auth/callback?code=valid-code&state=matching-state",
      {
        headers: {
          cookie: "synapse_oauth_state=matching-state",
        },
      }
    );
    const res = await GET(req);

    const sessionCookie = res.cookies.get("synapse_session");
    const sessionUser = await verifySessionToken(sessionCookie!.value, mockSecret);
    expect(sessionUser?.role).toBe("admin");
  });
});
