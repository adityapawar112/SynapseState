import { describe, it, expect } from "vitest";
import { server } from "./index.js";

describe("Control API Scaffolding", () => {
  it("initializes fastify server and /v1/time route", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/v1/time",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveProperty("server_time");
  });
});
