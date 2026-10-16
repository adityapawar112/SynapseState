import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  type GitHubClient,
  type GitHubFile,
  type GitHubPullRequest,
  type LeaseRecord,
  StalePrConflictError,
  FlagNotFoundError,
  InvalidFlagKeyError,
  InvalidEnvironmentError,
} from "./types.js";
import { GitHubReconciler } from "./reconciler.js";

describe("GitHubReconciler (PR 18)", () => {
  let mockClient: {
    getDefaultBranch: ReturnType<typeof vi.fn>;
    getBranchSha: ReturnType<typeof vi.fn>;
    createBranch: ReturnType<typeof vi.fn>;
    getFileContent: ReturnType<typeof vi.fn>;
    createOrUpdateFile: ReturnType<typeof vi.fn>;
    findOpenPullRequestsForFile: ReturnType<typeof vi.fn>;
    createPullRequest: ReturnType<typeof vi.fn>;
  };

  const config = {
    owner: "synapsestate",
    repo: "flags-repository",
    baseBranch: "main",
  };

  const sampleLease: LeaseRecord = {
    lease_id: "01J9X57YTRPQ8A7F4E12345678",
    flag_key: "checkout-v2",
    env: "production",
    payload: {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4E12345678",
      env: "production",
      flag_key: "checkout-v2",
      value: false,
      reason: "INC-142: Database connection pool exhaustion",
      issued_at: "2026-10-06T02:14:00.000Z",
      ttl_seconds: 1800,
      kid: "sre-alice-2026-01",
    },
    sig: "test-sig",
    state: "ACTIVE",
    created_by_kid: "sre-alice-2026-01",
  };

  const sampleYamlContent = `# Checkout feature flag configuration
class: release
owner: checkout-team
description: "Checkout v2 payment pipeline"
variants:
  on: true
  off: false
defaultVariant: "on"
`;

  beforeEach(() => {
    mockClient = {
      getDefaultBranch: vi.fn().mockResolvedValue("main"),
      getBranchSha: vi.fn().mockResolvedValue("abc123def456"),
      createBranch: vi.fn().mockResolvedValue(undefined),
      getFileContent: vi.fn().mockResolvedValue({
        content: sampleYamlContent,
        sha: "file-sha-123",
      } satisfies GitHubFile),
      createOrUpdateFile: vi
        .fn()
        .mockResolvedValue({ commitSha: "commit-sha-789" }),
      findOpenPullRequestsForFile: vi.fn().mockResolvedValue([]),
      createPullRequest: vi.fn().mockResolvedValue({
        number: 42,
        html_url: "https://github.com/synapsestate/flags-repository/pull/42",
        head_ref: "synapse/promote-lease-01J9X57YTRPQ8A7F4E12345678",
        title:
          "feat(flags): promote override for checkout-v2 in production (lease 01J9X57YTRPQ8A7F4E12345678)",
      } satisfies GitHubPullRequest),
    };
  });

  it("rejects invalid flag keys that violate regex ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", async () => {
    const reconciler = new GitHubReconciler(
      mockClient as unknown as GitHubClient,
      config,
    );

    const invalidKeys = [
      "Checkout-V2", // uppercase
      "-checkout", // starts with hyphen
      "checkout-", // ends with hyphen
      "checkout_v2", // underscore
      "checkout/v2", // path separator
      "../flags/etc", // traversal
      "flag with space",
    ];

    for (const key of invalidKeys) {
      await expect(
        reconciler.promoteLease({ ...sampleLease, flag_key: key }),
      ).rejects.toThrow(InvalidFlagKeyError);
    }
  });

  it("detects existing open PR for target flag file and throws StalePrConflictError with existing PR URL", async () => {
    mockClient.findOpenPullRequestsForFile.mockResolvedValue([
      {
        number: 10,
        html_url: "https://github.com/synapsestate/flags-repository/pull/10",
        head_ref: "synapse/promote-lease-01JOLDLEASE",
        title: "feat(flags): promote override for checkout-v2",
      },
    ]);

    const reconciler = new GitHubReconciler(
      mockClient as unknown as GitHubClient,
      config,
    );

    await expect(reconciler.promoteLease(sampleLease)).rejects.toThrow(
      StalePrConflictError,
    );

    try {
      await reconciler.promoteLease(sampleLease);
    } catch (err) {
      expect(err).toBeInstanceOf(StalePrConflictError);
      expect((err as StalePrConflictError).code).toBe("STALE_PR_CONFLICT");
      expect((err as StalePrConflictError).existingPrUrl).toBe(
        "https://github.com/synapsestate/flags-repository/pull/10",
      );
    }

    expect(mockClient.createBranch).not.toHaveBeenCalled();
    expect(mockClient.createPullRequest).not.toHaveBeenCalled();
  });

  it("throws FlagNotFoundError if flags/<env>/<flag_key>.yaml does not exist in target repo", async () => {
    mockClient.getFileContent.mockResolvedValueOnce(null);

    const reconciler = new GitHubReconciler(
      mockClient as unknown as GitHubClient,
      config,
    );

    await expect(reconciler.promoteLease(sampleLease)).rejects.toThrow(
      FlagNotFoundError,
    );
    expect(mockClient.createBranch).not.toHaveBeenCalled();
  });

  it("updates defaultVariant to matching variant key when variants is a dictionary of booleans", async () => {
    const reconciler = new GitHubReconciler(
      mockClient as unknown as GitHubClient,
      config,
    );

    const result = await reconciler.promoteLease(sampleLease);

    expect(result.lease_id).toBe("01J9X57YTRPQ8A7F4E12345678");
    expect(result.pr_url).toBe(
      "https://github.com/synapsestate/flags-repository/pull/42",
    );
    expect(result.branch).toBe(
      "synapse/promote-lease-01J9X57YTRPQ8A7F4E12345678",
    );
    expect(result.number).toBe(42);

    expect(mockClient.createOrUpdateFile).toHaveBeenCalledWith(
      config.owner,
      config.repo,
      expect.objectContaining({
        path: "flags/production/checkout-v2.yaml",
        branch: "synapse/promote-lease-01J9X57YTRPQ8A7F4E12345678",
        sha: "file-sha-123",
      }),
    );

    const savedContent = mockClient.createOrUpdateFile.mock.calls[0][2].content;
    expect(savedContent).toMatch(/defaultVariant:\s*["']?off["']?/);
    expect(savedContent).toContain("class: release");
    expect(savedContent).toContain("owner: checkout-team");
    expect(savedContent).toContain("# Checkout feature flag configuration");
  });

  it("updates defaultVariant when variants is a dictionary of strings or numbers", async () => {
    const stringVariantYaml = `class: release
owner: search-team
variants:
  v1: "legacy-algorithm"
  v2: "semantic-vector-search"
defaultVariant: "v1"
`;
    mockClient.getFileContent.mockResolvedValueOnce({
      content: stringVariantYaml,
      sha: "sha-str",
    });

    const reconciler = new GitHubReconciler(
      mockClient as unknown as GitHubClient,
      config,
    );

    await reconciler.promoteLease({
      ...sampleLease,
      flag_key: "search-algo",
      payload: {
        ...sampleLease.payload,
        flag_key: "search-algo",
        value: "semantic-vector-search",
      },
    });

    const savedContent = mockClient.createOrUpdateFile.mock.calls[0][2].content;
    expect(savedContent).toMatch(/defaultVariant:\s*["']?v2["']?/);
  });

  it("updates defaultVariant when variants is an array", async () => {
    const arrayVariantYaml = `class: release
owner: test-team
variants:
  - standard
  - expedited
defaultVariant: standard
`;
    mockClient.getFileContent.mockResolvedValueOnce({
      content: arrayVariantYaml,
      sha: "sha-arr",
    });

    const reconciler = new GitHubReconciler(
      mockClient as unknown as GitHubClient,
      config,
    );

    await reconciler.promoteLease({
      ...sampleLease,
      payload: {
        ...sampleLease.payload,
        value: "expedited",
      },
    });

    const savedContent = mockClient.createOrUpdateFile.mock.calls[0][2].content;
    expect(savedContent).toContain("defaultVariant: expedited");
  });

  it("creates branch synapse/promote-lease-<lease_id> from base branch head commit SHA", async () => {
    const reconciler = new GitHubReconciler(
      mockClient as unknown as GitHubClient,
      config,
    );

    await reconciler.promoteLease(sampleLease);

    expect(mockClient.getBranchSha).toHaveBeenCalledWith(
      config.owner,
      config.repo,
      "main",
    );
    expect(mockClient.createBranch).toHaveBeenCalledWith(
      config.owner,
      config.repo,
      "synapse/promote-lease-01J9X57YTRPQ8A7F4E12345678",
      "abc123def456",
    );
  });

  it("opens Pull Request with dual-control audit body linking incident metadata", async () => {
    const reconciler = new GitHubReconciler(
      mockClient as unknown as GitHubClient,
      config,
    );

    await reconciler.promoteLease(sampleLease);

    expect(mockClient.createPullRequest).toHaveBeenCalledWith(
      config.owner,
      config.repo,
      expect.objectContaining({
        title:
          "feat(flags): promote override for checkout-v2 in production (lease 01J9X57YTRPQ8A7F4E12345678)",
        head: "synapse/promote-lease-01J9X57YTRPQ8A7F4E12345678",
        base: "main",
        body: expect.stringContaining(
          "INC-142: Database connection pool exhaustion",
        ),
      }),
    );

    const prBody = mockClient.createPullRequest.mock.calls[0][2].body;
    expect(prBody).toContain("01J9X57YTRPQ8A7F4E12345678");
    expect(prBody).toContain("sre-alice-2026-01");
    expect(prBody).toContain("Dual-Control Peer Review Required");
    expect(prBody).toContain(
      "reconcile the Git baseline and transition emergency lease",
    );
    expect(mockClient.createPullRequest.mock.calls[0][2].draft).toBe(true);
  });

  it("rejects environments with path traversal or invalid characters (Issue 1)", async () => {
    const reconciler = new GitHubReconciler(
      mockClient as unknown as GitHubClient,
      config,
    );

    const invalidEnvs = ["../../etc", "prod/dev", "prod*env", "Production"];
    for (const badEnv of invalidEnvs) {
      await expect(
        reconciler.promoteLease({
          ...sampleLease,
          env: badEnv,
        }),
      ).rejects.toThrow(InvalidEnvironmentError);
    }
  });

  it("aborts and throws error if flag YAML has parse errors (Issue 5)", async () => {
    mockClient.getFileContent.mockResolvedValueOnce({
      content: "description: broken yaml\n\tinvalid tab character\nvariants: [",
      sha: "broken-sha",
    });

    const reconciler = new GitHubReconciler(
      mockClient as unknown as GitHubClient,
      config,
    );

    await expect(reconciler.promoteLease(sampleLease)).rejects.toThrow(
      /Failed to parse flag definition YAML/,
    );
  });

  it("maps Octokit 422 branch collision to StalePrConflictError (Issue 2)", async () => {
    const error422 = new Error("Reference already exists");
    (error422 as { status?: number }).status = 422;
    mockClient.createBranch.mockRejectedValueOnce(error422);

    const reconciler = new GitHubReconciler(
      mockClient as unknown as GitHubClient,
      config,
    );

    await expect(reconciler.promoteLease(sampleLease)).rejects.toThrow(
      StalePrConflictError,
    );
  });
});
