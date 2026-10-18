import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  createSessionToken,
  generateCsrfToken,
  getAuthConfigFromEnv,
  getSessionSecret,
  resolveUserRole,
} from "@/lib/auth";
import type { OidcSessionUser } from "@/lib/types";
import { controlApiClient } from "@/lib/api";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const savedState = request.cookies.get("synapse_oauth_state")?.value;

  if (!code || !state || state !== savedState) {
    const errorUrl = new URL("/login", request.url);
    errorUrl.searchParams.set("error", "invalid_oauth_state");
    return NextResponse.redirect(errorUrl);
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const errorUrl = new URL("/login", request.url);
    errorUrl.searchParams.set("error", "github_oauth_not_configured");
    return NextResponse.redirect(errorUrl);
  }

  try {
    // 1. Exchange authorization code for access token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || "Failed to obtain access token");
    }

    const accessToken = tokenData.access_token;

    // 2. Fetch user profile from GitHub API
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "SynapseState-Dashboard",
      },
    });
    const ghUser = await userRes.json();

    // 3. Fetch user teams and organization memberships defensively
    const [teamsRes, orgsRes] = await Promise.all([
      fetch("https://api.github.com/user/teams", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "SynapseState-Dashboard",
        },
      }).catch(() => null),
      fetch("https://api.github.com/user/orgs", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "SynapseState-Dashboard",
        },
      }).catch(() => null),
    ]);

    const ghTeams = teamsRes && teamsRes.ok ? await teamsRes.json().catch(() => []) : [];
    const teamSlugs: string[] = Array.isArray(ghTeams)
      ? ghTeams.map((t: { slug?: string; name?: string }) => t.slug || t.name || "").filter(Boolean)
      : [];

    if (orgsRes && orgsRes.ok) {
      const ghOrgs = await orgsRes.json().catch(() => []);
      if (Array.isArray(ghOrgs)) {
        ghOrgs.forEach((o: { login?: string }) => {
          if (o.login && !teamSlugs.includes(o.login)) {
            teamSlugs.push(o.login);
          }
        });
      }
    }

    // 4. Resolve RBAC role via pinned auth config
    const config = getAuthConfigFromEnv();
    const role = resolveUserRole(
      {
        login: ghUser.login,
        teams: teamSlugs,
        email: ghUser.email,
      },
      config
    );

    // 5. Mint authenticated session user (accessToken is discarded immediately)
    const sessionUser: OidcSessionUser = {
      id: String(ghUser.id),
      login: ghUser.login,
      name: ghUser.name || ghUser.login,
      avatarUrl: ghUser.avatar_url || "",
      email: ghUser.email || `${ghUser.login}@users.noreply.github.com`,
      role,
      teams: teamSlugs,
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    };

    const secret = getSessionSecret();
    const sessionToken = await createSessionToken(sessionUser, secret);
    const csrfToken = await generateCsrfToken(sessionUser.id, secret);

    // 6. Record DASHBOARD_LOGIN audit event asynchronously (fail-open)
    void controlApiClient.recordAuditEvent({
      actor: sessionUser.login,
      eventType: "DASHBOARD_LOGIN",
      payload: {
        role: sessionUser.role,
        teams: sessionUser.teams,
        name: sessionUser.name,
      },
    });

    const redirectUrl = new URL("/", request.url);
    const res = NextResponse.redirect(redirectUrl);


    res.cookies.set("synapse_session", sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 3600 * 24,
    });

    res.cookies.set("synapse_csrf", csrfToken, {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 3600 * 24,
    });

    res.cookies.delete("synapse_oauth_state");
    return res;
  } catch {
    const errorUrl = new URL("/login", request.url);
    errorUrl.searchParams.set("error", "oauth_exchange_failed");
    return NextResponse.redirect(errorUrl);
  }
}
