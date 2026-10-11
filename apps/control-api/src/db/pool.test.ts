import { describe, it, expect } from "vitest";
import { leasePool, telemetryPool, closePools, getPoolOptions, createPool } from "./pool.js";
import { Pool } from "pg";

describe("Database Connection Pool Isolation", () => {
  it("exports isolated pool instances for leases and telemetry", () => {
    expect(leasePool).toBeInstanceOf(Pool);
    expect(telemetryPool).toBeInstanceOf(Pool);
    expect(leasePool).not.toBe(telemetryPool);
  });

  it("configures distinct pool limits according to isolation charter", () => {
    const leaseOpts = getPoolOptions("lease");
    const telemetryOpts = getPoolOptions("telemetry");

    // High-priority lease pool: higher max connections, longer idle timeout
    expect(leaseOpts.max).toBeGreaterThanOrEqual(10);
    // Low-priority bulk telemetry pool: bounded to avoid starvation
    expect(telemetryOpts.max).toBeLessThanOrEqual(5);
    expect(leaseOpts.max).toBeGreaterThan(telemetryOpts.max!);
  });

  it("connects and executes queries independently across both pools", async () => {
    const leaseRes = await leasePool.query("SELECT 'lease' AS pool_name, 1 AS value");
    expect(leaseRes.rows[0]).toEqual({ pool_name: "lease", value: 1 });

    const telemetryRes = await telemetryPool.query("SELECT 'telemetry' AS pool_name, 2 AS value");
    expect(telemetryRes.rows[0]).toEqual({ pool_name: "telemetry", value: 2 });
  });

  it("supports creating independent custom pools and closing them gracefully", async () => {
    expect(typeof closePools).toBe("function");
    const customPool = createPool("telemetry");
    expect(customPool).toBeInstanceOf(Pool);
    const res = await customPool.query("SELECT 42 AS num");
    expect(res.rows[0]?.num).toBe(42);
    await customPool.end();
  });
});
