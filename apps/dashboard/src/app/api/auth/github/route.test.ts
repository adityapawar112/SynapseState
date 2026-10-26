import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

describe("API Route: GET /api/auth/github", () => {
  const origClientId = process.env.GITHUB_CLIENT_ID;

  beforeEach(() => {
    delete process.env.GITHUB_CLIENT_ID;
  });

  afterEach(() => {
    if (origClientId !== undefined) {
      process.env.GITHUB_CLIENT_ID = origClientId;
    } else {
      delete process.env.GITHUB_CLIENT_ID;
    }
  });

  it("redirects to /login?error=github_oauth_not_configured when GITHUB_CLIENT_ID is missing", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/github");
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toContain("/login?error=github_oauth_not_configured");
  });

  it("redirects to GitHub authorization endpoint with state and sets synapse_oauth_state cookie", async () => {
    process.env.GITHUB_CLIENT_ID = "test-github-client-id";

    const req = new NextRequest("http://localhost:3000/api/auth/github");
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin).toBe("https://github.com");
    expect(redirectUrl.pathname).toBe("/login/oauth/authorize");
    expect(redirectUrl.searchParams.get("client_id")).toBe(
      "test-github-client-id",
    );
    expect(redirectUrl.searchParams.get("scope")).toBe(
      "read:user read:org user:email",
    );
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/callback",
    );

    const state = redirectUrl.searchParams.get("state");
    expect(state).toHaveLength(64); // 32 hex bytes = 64 chars

    const stateCookie = res.cookies.get("synapse_oauth_state");
    expect(stateCookie).toBeDefined();
    expect(stateCookie?.value).toBe(state);
    expect(stateCookie?.httpOnly).toBe(true);
  });
});
