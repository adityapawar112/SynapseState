import { describe, it, expect } from "vitest";
import { app } from "./index.js";

describe("Demo Shop Probes & Lifecycle", () => {
  it("serves health probe GET /health returning status ok", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toEqual({ status: "ok" });
  });
});
