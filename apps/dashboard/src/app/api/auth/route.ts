import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  createSessionToken,
  verifySessionToken,
  getDevSessionUser,
} from "@/lib/auth";
import type { UserRole } from "@/lib/types";

const SECRET =
  process.env.SESSION_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  "default-development-session-secret-min-32-chars-long";

export async function GET(request: NextRequest) {
  const cookie = request.cookies.get("synapse_session")?.value;
  if (!cookie) {
    if (process.env.NODE_ENV !== "production") {
      const devUser = getDevSessionUser("operator");
      return NextResponse.json({ authenticated: true, user: devUser, isDev: true });
    }
    return NextResponse.json({ authenticated: false, user: null }, { status: 401 });
  }

  const user = verifySessionToken(cookie, SECRET);
  if (!user) {
    return NextResponse.json({ authenticated: false, user: null }, { status: 401 });
  }

  return NextResponse.json({ authenticated: true, user });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    role?: UserRole;
    action?: string;
  };

  const role = body.role || "operator";
  const user = getDevSessionUser(role);
  const token = createSessionToken(user, SECRET);

  const response = NextResponse.json({
    success: true,
    user,
    message: `Switched session to role: ${role}`,
  });

  response.cookies.set("synapse_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 3600 * 24, // 24 hours
  });

  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ success: true, message: "Logged out" });
  response.cookies.delete("synapse_session");
  return response;
}
