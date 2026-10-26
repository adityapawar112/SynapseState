import { describe, it, expect } from "vitest";
import { formatSessionRemaining } from "./UserProfileDropdown";

describe("formatSessionRemaining helper", () => {
  it("handles undefined or missing timestamp", () => {
    const res = formatSessionRemaining(undefined);
    expect(res.formatted).toBe("Unknown");
    expect(res.isNearExpiry).toBe(false);
    expect(res.isExpired).toBe(false);
  });

  it("formats hours, minutes, and seconds when remaining time is > 1 hour", () => {
    const future = new Date(
      Date.now() + 2 * 3600 * 1000 + 15 * 60 * 1000 + 30 * 1000,
    ).toISOString();
    const res = formatSessionRemaining(future);
    expect(res.formatted).toContain("2h 15m");
    expect(res.isNearExpiry).toBe(false);
    expect(res.isExpired).toBe(false);
  });

  it("flags near expiry when remaining time is <= 15 minutes", () => {
    const nearExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const res = formatSessionRemaining(nearExpiry);
    expect(res.isNearExpiry).toBe(true);
    expect(res.isExpired).toBe(false);
  });

  it("flags expired when timestamp is in the past", () => {
    const past = new Date(Date.now() - 5000).toISOString();
    const res = formatSessionRemaining(past);
    expect(res.formatted).toBe("Expired");
    expect(res.isExpired).toBe(true);
    expect(res.isNearExpiry).toBe(true);
  });
});
