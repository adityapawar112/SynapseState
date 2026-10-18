"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { OidcSessionUser, UserRole } from "@/lib/types";
import { RoleBadge } from "@/components/RoleBadge";
import {
  LuUser,
  LuLogOut,
  LuClock,
  LuShieldCheck,
  LuChevronDown,
  LuUsers,
  LuSparkles,
} from "react-icons/lu";

interface UserProfileDropdownProps {
  user: OidcSessionUser | null;
  role: UserRole;
}

export function formatSessionRemaining(expiresAtIso?: string): {
  formatted: string;
  isNearExpiry: boolean;
  isExpired: boolean;
} {
  if (!expiresAtIso) {
    return { formatted: "Unknown", isNearExpiry: false, isExpired: false };
  }

  const expiryTime = new Date(expiresAtIso).getTime();
  const now = Date.now();
  const diffSecs = Math.floor((expiryTime - now) / 1000);

  if (diffSecs <= 0) {
    return { formatted: "Expired", isNearExpiry: true, isExpired: true };
  }

  const hours = Math.floor(diffSecs / 3600);
  const minutes = Math.floor((diffSecs % 3600) / 60);
  const seconds = diffSecs % 60;

  const isNearExpiry = diffSecs <= 900; // < 15 mins

  if (hours > 0) {
    return {
      formatted: `${hours}h ${minutes}m ${seconds}s`,
      isNearExpiry,
      isExpired: false,
    };
  }
  return {
    formatted: `${minutes}m ${seconds}s`,
    isNearExpiry,
    isExpired: false,
  };
}

export function UserProfileDropdown({ user, role }: UserProfileDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [countdown, setCountdown] = useState(() =>
    formatSessionRemaining(user?.expiresAt)
  );
  const dropdownRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Tick live session expiry countdown every second
  useEffect(() => {
    if (!user?.expiresAt) return;

    setCountdown(formatSessionRemaining(user.expiresAt));

    const interval = setInterval(() => {
      setCountdown(formatSessionRemaining(user.expiresAt));
    }, 1000);

    return () => clearInterval(interval);
  }, [user?.expiresAt]);

  // Click-outside listener & escape key handler
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await fetch("/api/auth", {
        method: "DELETE",
      });
      setIsOpen(false);
      router.push("/login");
      router.refresh();
    } catch {
      // Fallback reload
      window.location.href = "/login";
    } finally {
      setIsLoggingOut(false);
    }
  };

  const displayName = user?.name || user?.login || "Anonymous Operator";
  const userLogin = user?.login || "anonymous";
  const userTeams = user?.teams || [];

  return (
    <div
      ref={dropdownRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      {/* Header Profile Trigger Button */}
      <button
        id="user-profile-menu-btn"
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "4px 10px",
          borderRadius: "var(--radius-full)",
          backgroundColor: "var(--color-cream)",
          border: "1px solid var(--color-hairline)",
          cursor: "pointer",
          outline: "none",
          transition: "all 0.15s ease",
        }}
      >
        {user?.avatarUrl ? (
          <img
            src={user.avatarUrl}

            alt={displayName}
            style={{
              width: "20px",
              height: "20px",
              borderRadius: "50%",
              objectFit: "cover",
            }}
          />
        ) : (
          <span
            style={{
              width: "20px",
              height: "20px",
              borderRadius: "50%",
              backgroundColor: "var(--color-kumo-brand)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#ffffff",
              fontSize: "11px",
              fontWeight: 600,
            }}
          >
            <LuUser size={12} />
          </span>
        )}

        <RoleBadge role={role} />

        <span
          style={{
            fontSize: "12px",
            color: "var(--color-ink-soft)",
            fontFamily: "var(--font-mono)",
            fontWeight: 500,
          }}
        >
          {userLogin}
        </span>

        <LuChevronDown
          size={12}
          color="var(--color-muted)"
          style={{
            transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.15s ease",
          }}
        />
      </button>

      {/* Popover Dropdown Menu */}
      {isOpen && (
        <div
          id="user-profile-dropdown-card"
          role="menu"
          aria-orientation="vertical"
          aria-labelledby="user-profile-menu-btn"
          className="card-hairline"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: "320px",
            backgroundColor: "var(--color-canvas)",
            zIndex: 200,
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
          }}
        >
          {/* User Info Header */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}

                alt={displayName}
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "var(--radius-sm)",
                  objectFit: "cover",
                  border: "1px solid var(--color-hairline)",
                }}
              />
            ) : (
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "var(--radius-sm)",
                  backgroundColor: "var(--color-kumo-brand)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#ffffff",
                }}
              >
                <LuUser size={20} />
              </div>
            )}

            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: "14px",
                  color: "var(--color-ink)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {displayName}
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--color-muted)",
                  fontFamily: "var(--font-mono)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                @{userLogin}
              </div>
              {user?.email && (
                <div
                  style={{
                    fontSize: "11px",
                    color: "var(--color-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginTop: "2px",
                  }}
                >
                  {user.email}
                </div>
              )}
            </div>
          </div>

          {/* Active Role and Permissions */}
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "var(--radius-xs)",
              backgroundColor: "var(--color-cream)",
              border: "1px solid var(--color-hairline)",
              fontSize: "12px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
              <span className="mono-caption" style={{ color: "var(--color-muted)" }}>Assigned Role</span>
              <RoleBadge role={role} />
            </div>
            <div style={{ fontSize: "11px", color: "var(--color-ink-soft)", lineHeight: 1.4 }}>
              {role === "admin" && "Full administrative permissions: View, Promote to Git, and Revoke."}
              {role === "operator" && "Incident response permissions: View, Promote to Git, and Revoke."}
              {role === "viewer" && "Read-only permissions: Flag inventory, Active Leases, and Audit Trail."}
            </div>
          </div>

          {/* Live Session Expiry Countdown */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderRadius: "var(--radius-xs)",
              backgroundColor: "var(--color-cream)",
              border: `1px solid ${
                countdown.isNearExpiry
                  ? "var(--color-kumo-brand)"
                  : "var(--color-hairline)"
              }`,
              fontSize: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--color-muted)" }}>
              <LuClock size={13} color={countdown.isNearExpiry ? "var(--color-kumo-brand)" : undefined} />
              <span>Session TTL:</span>
            </div>
            <span
              id="session-countdown-timer"
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                color: countdown.isNearExpiry
                  ? "var(--color-kumo-brand)"
                  : "var(--color-storage)",
              }}
            >
              {countdown.formatted}
            </span>
          </div>

          {/* Teams list */}
          {userTeams.length > 0 && (
            <div>
              <div
                className="mono-caption"
                style={{
                  color: "var(--color-muted)",
                  marginBottom: "6px",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <LuUsers size={11} />
                <span>Mapped Teams ({userTeams.length})</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                {userTeams.map((team) => (
                  <span
                    key={team}
                    className="code-inline"
                    style={{ fontSize: "10px", padding: "2px 6px" }}
                  >
                    {team}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Safety Notice Footer */}
          <div
            style={{
              fontSize: "10px",
              color: "var(--color-muted)",
              display: "flex",
              alignItems: "center",
              gap: "4px",
              borderTop: "1px solid var(--color-hairline)",
              paddingTop: "10px",
            }}
          >
            <LuShieldCheck size={12} color="var(--color-storage)" />
            <span>Pinned Keyset Trust Root • Web Tier Air-Gapped</span>
          </div>

          {/* Action Links */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              borderTop: "1px solid var(--color-hairline)",
              paddingTop: "10px",
            }}
          >
            <Link
              href="/login"
              id="dropdown-switch-role-link"
              onClick={() => setIsOpen(false)}
              className="btn btn-secondary"
              style={{
                fontSize: "12px",
                height: "30px",
                padding: "2px 10px",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <LuSparkles size={12} />
              <span>Switch Role</span>
            </Link>

            <button
              id="logout-btn"
              type="button"
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="btn btn-danger"
              style={{
                fontSize: "12px",
                height: "30px",
                padding: "2px 12px",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
              }}
            >
              <LuLogOut size={12} />
              <span>{isLoggingOut ? "Signing Out…" : "Sign Out"}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
