import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST, DELETE } from "./route";
import { createSessionToken, getDevSessionUser } from "@/lib/auth";

describe("API Route: /api/auth", () => {
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
  });

  afterEach(() => {
    setNodeEnv(origEnv);
    if (origDevAuth !== undefined) process.env.SYNAPSE_DEV_AUTH = origDevAuth;
    else delete process.env.SYNAPSE_DEV_AUTH;
    if (origSecret !== undefined) process.env.SESSION_SECRET = origSecret;
    else delete process.env.SESSION_SECRET;
  });

  it("POST /api/auth rejects role switching in production without SYNAPSE_DEV_AUTH", async () => {
    setNodeEnv("production");
    delete process.env.SYNAPSE_DEV_AUTH;

    const req = new NextRequest("http://localhost:3000/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("FORBIDDEN");
  });

  it("POST /api/auth allows role switching in development environment", async () => {
    setNodeEnv("development");

    const req = new NextRequest("http://localhost:3000/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "operator" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.user.role).toBe("operator");
    expect(data.csrfToken).toBeTruthy();

    const sessionCookie = res.cookies.get("synapse_session");
    expect(sessionCookie).toBeTruthy();
    const csrfCookie = res.cookies.get("synapse_csrf");
    expect(csrfCookie).toBeTruthy();
  });

  it("GET /api/auth returns 401 when unauthenticated and dev auth disabled", async () => {
    setNodeEnv("production");
    const req = new NextRequest("http://localhost:3000/api/auth");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("GET /api/auth returns session user when valid cookie is provided", async () => {
    const user = getDevSessionUser("operator");
    const token = await createSessionToken(user, testSecret);

    const req = new NextRequest("http://localhost:3000/api/auth", {
      headers: {
        cookie: `synapse_session=${token}`,
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.authenticated).toBe(true);
    expect(data.user.login).toBe(user.login);
    expect(data.csrfToken).toBeTruthy();
  });

  it("DELETE /api/auth clears session and csrf cookies", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    const deletedSession = res.cookies.get("synapse_session");
    expect(deletedSession?.value).toBe("");
  });
});
