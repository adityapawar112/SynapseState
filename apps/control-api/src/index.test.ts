import { describe, it, expect } from "vitest";
import { server } from "./index.js";

describe("Control API Server Wiring & Probes", () => {
  it("serves GET /v1/time route", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/v1/time",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveProperty("server_time");
  });

  it("serves liveness probe GET /healthz", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/healthz",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toEqual({ status: "ok" });
  });

  it("serves readiness probe GET /readyz verifying database connectivity", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/readyz",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toEqual({ status: "ok", db: "connected" });
  });

  it("hooks auditSealer start and stop into Fastify ready and close lifecycle", async () => {
    let started = false;
    let stopped = false;

    const mockSealer = {
      start: () => {
        started = true;
      },
      stop: async () => {
        stopped = true;
      },
    } as unknown as import("./sealer/index.js").AuditSealer;

    const testServer = (await import("./app.js")).buildServer({
      auditSealer: mockSealer,
    });

    expect(started).toBe(false);
    expect(stopped).toBe(false);

    await testServer.ready();
    expect(started).toBe(true);

    await testServer.close();
    expect(stopped).toBe(true);
  });
});
