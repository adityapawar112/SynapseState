import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import { OctokitGitHubClient } from "./client.js";

describe("OctokitGitHubClient", () => {
  let mockOctokit: {
    rest: {
      repos: {
        get: ReturnType<typeof vi.fn>;
        getBranch: ReturnType<typeof vi.fn>;
        getContent: ReturnType<typeof vi.fn>;
        createOrUpdateFileContents: ReturnType<typeof vi.fn>;
      };
      git: {
        createRef: ReturnType<typeof vi.fn>;
      };
      pulls: {
        list: ReturnType<typeof vi.fn>;
        listFiles: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
      };
    };
  };
  let client: OctokitGitHubClient;

  beforeEach(() => {
    mockOctokit = {
      rest: {
        repos: {
          get: vi.fn().mockResolvedValue({ data: { default_branch: "main" } }),
          getBranch: vi
            .fn()
            .mockResolvedValue({ data: { commit: { sha: "head-sha-123" } } }),
          getContent: vi.fn().mockResolvedValue({
            data: {
              content: Buffer.from("class: release\n", "utf-8").toString(
                "base64",
              ),
              sha: "blob-sha-456",
              type: "file",
            },
          }),
          createOrUpdateFileContents: vi.fn().mockResolvedValue({
            data: { commit: { sha: "commit-sha-789" } },
          }),
        },
        git: {
          createRef: vi.fn().mockResolvedValue({ data: {} }),
        },
        pulls: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn().mockResolvedValue({
            data: {
              number: 99,
              html_url: "https://github.com/org/repo/pull/99",
              head: { ref: "synapse/promote-lease-1" },
              title: "feat(flags): promote override",
            },
          }),
        },
      },
    };

    client = new OctokitGitHubClient(mockOctokit as unknown as Octokit);
  });

  it("retrieves default branch", async () => {
    const branch = await client.getDefaultBranch("org", "repo");
    expect(branch).toBe("main");
    expect(mockOctokit.rest.repos.get).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
    });
  });

  it("retrieves branch head commit sha", async () => {
    const sha = await client.getBranchSha("org", "repo", "main");
    expect(sha).toBe("head-sha-123");
    expect(mockOctokit.rest.repos.getBranch).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      branch: "main",
    });
  });

  it("creates git reference branch", async () => {
    await client.createBranch("org", "repo", "feat-branch", "commit-sha");
    expect(mockOctokit.rest.git.createRef).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      ref: "refs/heads/feat-branch",
      sha: "commit-sha",
    });
  });

  it("gets file content and decodes base64", async () => {
    const file = await client.getFileContent(
      "org",
      "repo",
      "flags/prod/test.yaml",
      "main",
    );
    expect(file).toEqual({
      content: "class: release\n",
      sha: "blob-sha-456",
    });
  });

  it("returns null when file does not exist (404)", async () => {
    const err = new Error("Not Found");
    (err as unknown as { status: number }).status = 404;
    mockOctokit.rest.repos.getContent.mockRejectedValueOnce(err);

    const file = await client.getFileContent("org", "repo", "missing.yaml");
    expect(file).toBeNull();
  });

  it("creates or updates file with base64 encoded content", async () => {
    const res = await client.createOrUpdateFile("org", "repo", {
      path: "flags/prod/test.yaml",
      message: "feat: update flag",
      content: "updated content",
      branch: "promo-branch",
      sha: "existing-sha",
    });

    expect(res.commitSha).toBe("commit-sha-789");
    expect(
      mockOctokit.rest.repos.createOrUpdateFileContents,
    ).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      path: "flags/prod/test.yaml",
      message: "feat: update flag",
      content: Buffer.from("updated content", "utf-8").toString("base64"),
      branch: "promo-branch",
      sha: "existing-sha",
    });
  });

  it("finds open pull requests touching target file path", async () => {
    mockOctokit.rest.pulls.list.mockResolvedValueOnce({
      data: [
        {
          number: 10,
          html_url: "https://github.com/org/repo/pull/10",
          head: { ref: "feature-branch" },
          title: "PR 10",
        },
        {
          number: 11,
          html_url: "https://github.com/org/repo/pull/11",
          head: { ref: "unrelated-branch" },
          title: "PR 11",
        },
      ],
    });

    mockOctokit.rest.pulls.listFiles
      .mockResolvedValueOnce({
        data: [{ filename: "flags/prod/test.yaml" }],
      })
      .mockResolvedValueOnce({
        data: [{ filename: "flags/prod/other.yaml" }],
      });

    const matches = await client.findOpenPullRequestsForFile(
      "org",
      "repo",
      "flags/prod/test.yaml",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].number).toBe(10);
    expect(matches[0].html_url).toBe("https://github.com/org/repo/pull/10");
  });

  it("creates pull request and maps response", async () => {
    const pr = await client.createPullRequest("org", "repo", {
      title: "PR Title",
      body: "PR Body",
      head: "promo-branch",
      base: "main",
    });

    expect(pr.number).toBe(99);
    expect(pr.html_url).toBe("https://github.com/org/repo/pull/99");
    expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      title: "PR Title",
      body: "PR Body",
      head: "promo-branch",
      base: "main",
    });
  });
});
