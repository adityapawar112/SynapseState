import { describe, it, expect, vi } from "vitest";
import { DefaultGrafanaClient } from "./client.js";

describe("DefaultGrafanaClient (PR 26)", () => {
  it("throws error when API key is not configured", async () => {
    const client = new DefaultGrafanaClient({
      url: "http://localhost:3000",
      apiKey: "",
    });

    await expect(
      client.createAnnotation({
        time: 1729261800000,
        text: "Test annotation",
        tags: ["synapse"],
      }),
    ).rejects.toThrow("Grafana API key/token is not configured");
  });

  it("successfully dispatches annotation to Grafana POST /api/annotations", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 101, message: "Annotation added" }),
    });

    const client = new DefaultGrafanaClient({
      url: "https://grafana.example.com",
      apiKey: "glsa_test_token_123",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const res = await client.createAnnotation({
      time: 1729261800000,
      text: "Test annotation",
      tags: ["synapse", "test"],
    });

    expect(res).toEqual({ id: 101, message: "Annotation added" });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe("https://grafana.example.com/api/annotations");
    expect(calledOpts.method).toBe("POST");
    expect(calledOpts.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer glsa_test_token_123",
    });
    expect(JSON.parse(calledOpts.body)).toEqual({
      time: 1729261800000,
      text: "Test annotation",
      tags: ["synapse", "test"],
    });
  });

  it("throws error when Grafana API returns non-2xx status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    const client = new DefaultGrafanaClient({
      url: "https://grafana.example.com",
      apiKey: "invalid-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      client.createAnnotation({
        time: 1729261800000,
        text: "Test annotation",
        tags: ["synapse"],
      }),
    ).rejects.toThrow("Grafana API returned HTTP 403: Forbidden");
  });

  it("aborts and throws error when request exceeds timeoutMs (M5)", async () => {
    const hangingFetch = vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const client = new DefaultGrafanaClient({
      url: "https://grafana.example.com",
      apiKey: "test-token",
      timeoutMs: 25,
      fetchFn: hangingFetch as unknown as typeof fetch,
    });

    await expect(
      client.createAnnotation({
        time: 1729261800000,
        text: "Test annotation",
        tags: ["synapse"],
      }),
    ).rejects.toThrow(/aborted/);
  });
});
