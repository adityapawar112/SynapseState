export interface GitHubFile {
  content: string;
  sha: string;
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  head_ref: string;
  title: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  merged_at?: string | null;
  merged_by?: { login: string } | null;
}

export interface GitHubClient {
  getDefaultBranch(owner: string, repo: string): Promise<string>;
  getBranchSha(owner: string, repo: string, branch: string): Promise<string>;
  createBranch(
    owner: string,
    repo: string,
    branch: string,
    sha: string,
  ): Promise<void>;
  getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GitHubFile | null>;
  createOrUpdateFile(
    owner: string,
    repo: string,
    params: {
      path: string;
      message: string;
      content: string;
      branch: string;
      sha?: string;
    },
  ): Promise<{ commitSha: string }>;
  findOpenPullRequestsForFile(
    owner: string,
    repo: string,
    filePath: string,
  ): Promise<GitHubPullRequest[]>;
  createPullRequest(
    owner: string,
    repo: string,
    params: {
      title: string;
      body: string;
      head: string;
      base: string;
      draft?: boolean;
    },
  ): Promise<GitHubPullRequest>;
}

export interface GitHubReconcilerConfig {
  owner: string;
  repo: string;
  baseBranch?: string;
}

export interface LeaseRecord {
  lease_id: string;
  flag_key: string;
  env: string;
  payload: {
    v: number;
    lease_id: string;
    env: string;
    flag_key: string;
    value: unknown;
    reason: string;
    issued_at: string;
    ttl_seconds: number;
    kid: string;
    nonce?: string;
  };
  sig: string;
  state: string;
  created_by_kid: string;
  promote_pr_url?: string | null;
}

export interface PromoteLeaseResult {
  lease_id: string;
  pr_url: string;
  branch: string;
  number: number;
}

export class StalePrConflictError extends Error {
  readonly code = "STALE_PR_CONFLICT";
  readonly existingPrUrl?: string;

  constructor(message: string, existingPrUrl?: string) {
    super(message);
    this.name = "StalePrConflictError";
    this.existingPrUrl = existingPrUrl;
  }
}

export class FlagNotFoundError extends Error {
  readonly code = "FLAG_NOT_FOUND";
  readonly flagKey: string;
  readonly env: string;

  constructor(flagKey: string, env: string) {
    super(`Flag definition not found at flags/${env}/${flagKey}.yaml`);
    this.name = "FlagNotFoundError";
    this.flagKey = flagKey;
    this.env = env;
  }
}

export class InvalidFlagKeyError extends Error {
  readonly code = "INVALID_FLAG_KEY";
  readonly flagKey: string;

  constructor(flagKey: string) {
    super(
      `Flag key "${flagKey}" does not match required regex ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`,
    );
    this.name = "InvalidFlagKeyError";
    this.flagKey = flagKey;
  }
}

export class InvalidEnvironmentError extends Error {
  readonly code = "INVALID_ENVIRONMENT";
  readonly env: string;

  constructor(env: string) {
    super(
      `Environment "${env}" does not match required regex ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`,
    );
    this.name = "InvalidEnvironmentError";
    this.env = env;
  }
}

export class FlagDefinitionParseError extends Error {
  readonly code = "FLAG_PARSE_ERROR";
  readonly flagKey: string;
  readonly env: string;

  constructor(flagKey: string, env: string, details: string) {
    super(
      `Failed to parse flag definition YAML for ${flagKey} in ${env}: ${details}`,
    );
    this.name = "FlagDefinitionParseError";
    this.flagKey = flagKey;
    this.env = env;
  }
}

export interface GitHubWebhookPullRequestPayload {
  action: string;
  number: number;
  pull_request?: {
    number: number;
    html_url: string;
    state: string;
    title: string;
    merged: boolean;
    merge_commit_sha?: string | null;
    merged_at?: string | null;
    merged_by?: { login: string } | null;
    head: {
      ref: string;
      sha: string;
    };
    base: {
      ref: string;
    };
  };
  repository?: {
    name: string;
    owner: {
      login: string;
    };
  };
  sender?: {
    login: string;
  };
}
