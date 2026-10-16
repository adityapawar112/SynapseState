import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { executePromote, registerPromoteCommands } from "./promote.js";

describe("Promote Command (packages/cli/src/commands/promote.ts) - PR 18", () => {
  const validUlid = "01J9X57YTRPQ8A7F4E12345678";
  const defaultApiUrl = "http://localhost:3000";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid lease ID format that is not a valid Crockford ULID", async () => {
    const invalidIds = [
      "123",
      "not-a-ulid",
      "01J9X57YTRPQ8A7F4E1234567!",
      "lower-case-ulid-01j9x57ytr",
    ];

    for (const badId of invalidIds) {
      await expect(
        executePromote({
          leaseId: badId,
        }),
      ).rejects.toThrow(/Invalid lease ID/);
    }
  });

  it("sends POST request to /v1/leases/:id/promote with Authorization Bearer header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        lease_id: validUlid,
        pr_url: "https://github.com/synapsestate/flags/pull/101",
        branch: `synapse/promote-lease-${validUlid}`,
      }),
    });

    const result = await executePromote({
      leaseId: validUlid,
      apiUrl: defaultApiUrl,
      token: "secret-operator-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      `${defaultApiUrl}/v1/leases/${validUlid}/promote`,
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: "Bearer secret-operator-token",
        },
      }),
    );

    expect(result.leaseId).toBe(validUlid);
    expect(result.prUrl).toBe("https://github.com/synapsestate/flags/pull/101");
    expect(result.branch).toBe(`synapse/promote-lease-${validUlid}`);
  });

  it("handles 401 Unauthorized with clear guidance to provide --token or SYNAPSE_API_TOKEN", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: "UNAUTHORIZED",
        message: "Missing or invalid Authorization header",
      }),
    });

    await expect(
      executePromote({
        leaseId: validUlid,
        apiUrl: defaultApiUrl,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Authentication failed.*--token.*SYNAPSE_API_TOKEN/i);
  });

  it("handles 404 Not Found when lease does not exist", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        error: "NOT_FOUND",
        message: `Lease "${validUlid}" not found`,
      }),
    });

    await expect(
      executePromote({
        leaseId: validUlid,
        apiUrl: defaultApiUrl,
        token: "some-token",
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("handles 409 STALE_PR_CONFLICT with conflict message and existing PR link", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: "STALE_PR_CONFLICT",
        message: "An open pull request already exists for this flag baseline",
        existing_pr_url: "https://github.com/synapsestate/flags/pull/50",
      }),
    });

    await expect(
      executePromote({
        leaseId: validUlid,
        apiUrl: defaultApiUrl,
        token: "some-token",
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/https:\/\/github\.com\/synapsestate\/flags\/pull\/50/);
  });

  it("formats machine-readable JSON output when --json is passed", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        lease_id: validUlid,
        pr_url: "https://github.com/synapsestate/flags/pull/101",
        branch: `synapse/promote-lease-${validUlid}`,
      }),
    });

    const result = await executePromote({
      leaseId: validUlid,
      apiUrl: defaultApiUrl,
      token: "secret-token",
      json: true,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const parsedJson = JSON.parse(result.formattedOutput);
    expect(parsedJson).toEqual({
      lease_id: validUlid,
      pr_url: "https://github.com/synapsestate/flags/pull/101",
      branch: `synapse/promote-lease-${validUlid}`,
    });
  });

  it("formats styled terminal box when human output is requested", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        lease_id: validUlid,
        pr_url: "https://github.com/synapsestate/flags/pull/101",
        branch: `synapse/promote-lease-${validUlid}`,
      }),
    });

    const result = await executePromote({
      leaseId: validUlid,
      apiUrl: defaultApiUrl,
      token: "secret-token",
      json: false,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.formattedOutput).toContain("Promotion Initiated");
    expect(result.formattedOutput).toContain(validUlid);
    expect(result.formattedOutput).toContain(
      "https://github.com/synapsestate/flags/pull/101",
    );
    expect(result.formattedOutput).toContain("Dual-Control");
    expect(result.formattedOutput).toContain("secondary approval");
  });

  it("registers promote command on Commander program", () => {
    const program = new Command();
    registerPromoteCommands(program);

    const cmd = program.commands.find((c) => c.name() === "promote");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Git reconciliation Pull Request");
  });

  it("passes env in POST body when env param is provided (Issue 7)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        lease_id: validUlid,
        pr_url: "https://github.com/synapsestate/flags/pull/101",
        branch: `synapse/promote-lease-${validUlid}`,
      }),
    });

    await executePromote({
      leaseId: validUlid,
      env: "production",
      apiUrl: defaultApiUrl,
      token: "secret-operator-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      `${defaultApiUrl}/v1/leases/${validUlid}/promote`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ env: "production" }),
      }),
    );
  });

  it("handles 403 Forbidden with clear operator role error (C3 blocker)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: "FORBIDDEN",
        message:
          "API token does not have operator or admin role required for promotion",
      }),
    });

    await expect(
      executePromote({
        leaseId: validUlid,
        apiUrl: defaultApiUrl,
        token: "telemetry-token",
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Forbidden.*operator or admin role/i);
  });

  it("handles request timeout with clear error message (Issue 8)", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    const mockFetch = vi.fn().mockRejectedValue(timeoutErr);

    await expect(
      executePromote({
        leaseId: validUlid,
        apiUrl: defaultApiUrl,
        timeoutMs: 100,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/timed out after 100ms/i);
  });
});
