import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("error", "github_oauth_not_configured");
    return NextResponse.redirect(redirectUrl);
  }

  const redirectUri = new URL("/api/auth/callback", request.url).toString();
  const state = Math.random().toString(36).substring(2, 15);

  const githubAuthUrl = new URL("https://github.com/login/oauth/authorize");
  githubAuthUrl.searchParams.set("client_id", clientId);
  githubAuthUrl.searchParams.set("redirect_uri", redirectUri);
  githubAuthUrl.searchParams.set("scope", "read:user read:org user:email");
  githubAuthUrl.searchParams.set("state", state);

  const res = NextResponse.redirect(githubAuthUrl);
  res.cookies.set("synapse_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600, // 10 minutes
  });
  return res;
}
