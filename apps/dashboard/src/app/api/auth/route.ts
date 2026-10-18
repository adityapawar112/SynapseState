import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  createSessionToken,
  verifySessionToken,
  generateCsrfToken,
  getDevSessionUser,
  getSessionSecret,
} from "@/lib/auth";
import type { UserRole } from "@/lib/types";

export async function GET(request: NextRequest) {
  const secret = getSessionSecret();
  const cookie = request.cookies.get("synapse_session")?.value;

  if (!cookie) {
    if (process.env.NODE_ENV !== "production" && process.env.SYNAPSE_DEV_AUTH === "true") {
      const devUser = getDevSessionUser("operator");
      const csrfToken = await generateCsrfToken(devUser.id, secret);
      return NextResponse.json({ authenticated: true, user: devUser, isDev: true, csrfToken });
    }
    return NextResponse.json({ authenticated: false, user: null }, { status: 401 });
  }

  const user = await verifySessionToken(cookie, secret);
  if (!user) {
    return NextResponse.json({ authenticated: false, user: null }, { status: 401 });
  }

  const csrfToken = await generateCsrfToken(user.id, secret);
  return NextResponse.json({ authenticated: true, user, csrfToken });
}

export async function POST(request: NextRequest) {
  // Security Guard: Prohibit uncredentialed session minting in production under all conditions
  if (process.env.NODE_ENV === "production" || process.env.SYNAPSE_DEV_AUTH !== "true") {
    return NextResponse.json(
      {
        error: "FORBIDDEN",
        message:
          "Direct session minting is disabled in production. Authenticate via GitHub OIDC.",
      },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    role?: UserRole;
    action?: string;
  };

  const role = body.role || "operator";
  const user = getDevSessionUser(role);
  const secret = getSessionSecret();
  const token = await createSessionToken(user, secret);
  const csrfToken = await generateCsrfToken(user.id, secret);

  const response = NextResponse.json({
    success: true,
    user,
    csrfToken,
    message: `Switched session to role: ${role}`,
  });

  const isProduction = (process.env.NODE_ENV as string) === "production";

  response.cookies.set("synapse_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: 3600 * 24, // 24 hours
  });

  response.cookies.set("synapse_csrf", csrfToken, {
    httpOnly: false, // Accessible to client-side JS for x-synapse-csrf header
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: 3600 * 24,
  });

  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ success: true, message: "Logged out" });
  response.cookies.delete("synapse_session");
  response.cookies.delete("synapse_csrf");
  return response;
}
