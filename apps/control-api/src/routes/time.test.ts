import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { timeRoutes } from "./time.js";

describe("Time Synchronization Route (GET /v1/time)", () => {
  it("returns 200 OK with ISO8601 server_time", async () => {
    const app = Fastify();
    await app.register(timeRoutes);

    const before = Date.now();
    const res = await app.inject({
      method: "GET",
      url: "/v1/time",
    });
    const after = Date.now();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty("server_time");
    expect(typeof body.server_time).toBe("string");

    const parsed = Date.parse(body.server_time);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(after + 1000);
  });
});
