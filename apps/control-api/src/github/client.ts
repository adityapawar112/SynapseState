import { Octokit } from "@octokit/rest";
import type { GitHubClient, GitHubFile, GitHubPullRequest } from "./types.js";

export interface GitHubClientOptions {
  auth?: string;
  octokit?: Octokit;
}

export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;

  constructor(octokit?: Octokit, auth?: string) {
    this.octokit =
      octokit ??
      new Octokit({
        auth: auth || process.env.GITHUB_TOKEN,
      });
  }

  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const { data } = await this.octokit.rest.repos.get({ owner, repo });
    return data.default_branch;
  }

  async getBranchSha(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string> {
    const { data } = await this.octokit.rest.repos.getBranch({
      owner,
      repo,
      branch,
    });
    return data.commit.sha;
  }

  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    sha: string,
  ): Promise<void> {
    await this.octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GitHubFile | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ...(ref ? { ref } : {}),
      });

      if (!data || Array.isArray(data) || !("content" in data)) {
        return null;
      }

      const content = Buffer.from(data.content, "base64").toString("utf-8");
      return {
        content,
        sha: data.sha,
      };
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) {
        return null;
      }
      throw err;
    }
  }

  async createOrUpdateFile(
    owner: string,
    repo: string,
    params: {
      path: string;
      message: string;
      content: string;
      branch: string;
      sha?: string;
    },
  ): Promise<{ commitSha: string }> {
    const base64Content = Buffer.from(params.content, "utf-8").toString(
      "base64",
    );

    const { data } = await this.octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: params.path,
      message: params.message,
      content: base64Content,
      branch: params.branch,
      ...(params.sha ? { sha: params.sha } : {}),
    });

    return { commitSha: data.commit.sha || "" };
  }

  async findOpenPullRequestsForFile(
    owner: string,
    repo: string,
    filePath: string,
  ): Promise<GitHubPullRequest[]> {
    const { data: pullRequests } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      per_page: 50,
    });

    const matchingPrs: GitHubPullRequest[] = [];

    const targetFlagKey = filePath.split("/").pop()?.replace(".yaml", "") ?? "";
    const flagKeyRegex = targetFlagKey
      ? new RegExp(`(^|[^a-z0-9-])${targetFlagKey}([^a-z0-9]|$)`)
      : null;

    for (const pr of pullRequests) {
      // If the branch name already matches promotion branch pattern for this lease/flag
      if (
        pr.head.ref.startsWith("synapse/promote-lease-") &&
        flagKeyRegex &&
        flagKeyRegex.test(pr.title)
      ) {
        matchingPrs.push({
          number: pr.number,
          html_url: pr.html_url,
          head_ref: pr.head.ref,
          title: pr.title,
        });
        continue;
      }

      // Check changed files for this PR
      try {
        const { data: files } = await this.octokit.rest.pulls.listFiles({
          owner,
          repo,
          pull_number: pr.number,
          per_page: 100,
        });

        if (files.some((f) => f.filename === filePath)) {
          matchingPrs.push({
            number: pr.number,
            html_url: pr.html_url,
            head_ref: pr.head.ref,
            title: pr.title,
          });
        }
      } catch {
        // Continue checking other PRs if listing files fails for one
      }
    }

    return matchingPrs;
  }

  async createPullRequest(
    owner: string,
    repo: string,
    params: {
      title: string;
      body: string;
      head: string;
      base: string;
      draft?: boolean;
    },
  ): Promise<GitHubPullRequest> {
    const { data } = await this.octokit.rest.pulls.create({
      owner,
      repo,
      title: params.title,
      body: params.body,
      head: params.head,
      base: params.base,
      draft: params.draft,
    });

    return {
      number: data.number,
      html_url: data.html_url,
      head_ref: data.head.ref,
      title: data.title,
    };
  }
}

export function createGitHubClient(
  options: GitHubClientOptions = {},
): GitHubClient {
  return new OctokitGitHubClient(options.octokit, options.auth);
}
