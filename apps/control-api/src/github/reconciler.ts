import YAML from "yaml";
import {
  type GitHubClient,
  type GitHubReconcilerConfig,
  type LeaseRecord,
  type PromoteLeaseResult,
  StalePrConflictError,
  FlagNotFoundError,
  InvalidFlagKeyError,
  InvalidEnvironmentError,
} from "./types.js";

export const FLAG_KEY_REGEX = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * Resolves the appropriate defaultVariant value to write to flag YAML.
 * Checks whether variants are defined as an object map, array, or scalar,
 * mapping override values (e.g. false) to the corresponding variant name (e.g. "off").
 */
export function resolveDefaultVariant(
  doc: YAML.Document,
  overrideValue: unknown,
): unknown {
  const parsed = doc.toJS() as { variants?: unknown } | null;
  const variants = parsed?.variants;

  if (variants && typeof variants === "object") {
    if (Array.isArray(variants)) {
      const match = variants.find(
        (v) => v === overrideValue || String(v) === String(overrideValue),
      );
      if (match !== undefined) return match;
    } else {
      // Check if overrideValue directly matches a variant key
      if (typeof overrideValue === "string" && overrideValue in variants) {
        return overrideValue;
      }
      // Check if any variant value matches overrideValue
      for (const [key, val] of Object.entries(variants)) {
        if (val === overrideValue || String(val) === String(overrideValue)) {
          return key;
        }
      }
    }
  }

  return overrideValue;
}

export class GitHubReconciler {
  private readonly client: GitHubClient;
  private readonly config: GitHubReconcilerConfig;

  constructor(client: GitHubClient, config: GitHubReconcilerConfig) {
    this.client = client;
    this.config = config;
  }

  /**
   * Promotes an emergency lease override to Git by:
   * 1. Validating flag key charset (ADR 0007).
   * 2. Checking for conflicting open PRs for flags/<env>/<flag_key>.yaml.
   * 3. Fetching existing flag definition and updating defaultVariant to the override value.
   * 4. Creating a dedicated promotion branch: synapse/promote-lease-<lease_id>.
   * 5. Committing the updated YAML and opening a secondary-approval Pull Request.
   */
  async promoteLease(lease: LeaseRecord): Promise<PromoteLeaseResult> {
    const { flag_key, env, lease_id } = lease;
    const { owner, repo } = this.config;
    const baseBranch = this.config.baseBranch || "main";

    // 1. Flag key and environment charset validation (prevent path traversal / ref injection)
    if (!FLAG_KEY_REGEX.test(flag_key)) {
      throw new InvalidFlagKeyError(flag_key);
    }
    if (!FLAG_KEY_REGEX.test(env)) {
      throw new InvalidEnvironmentError(env);
    }

    const filePath = `flags/${env}/${flag_key}.yaml`;

    // 2. Stale PR conflict check
    const openPrs = await this.client.findOpenPullRequestsForFile(
      owner,
      repo,
      filePath,
    );
    if (openPrs.length > 0) {
      const existingPr = openPrs[0];
      throw new StalePrConflictError(
        `An open pull request already exists for flag "${flag_key}" in ${env}: ${existingPr.html_url}`,
        existingPr.html_url,
      );
    }

    // 3. Fetch existing flag definition YAML
    const existingFile = await this.client.getFileContent(
      owner,
      repo,
      filePath,
      baseBranch,
    );
    if (!existingFile) {
      throw new FlagNotFoundError(flag_key, env);
    }

    // 4. Parse YAML preserving comments and metadata, update defaultVariant
    const doc = YAML.parseDocument(existingFile.content);
    if (doc.errors && doc.errors.length > 0) {
      throw new Error(
        `Failed to parse flag definition YAML for ${flag_key} in ${env}: ${doc.errors[0].message}`,
      );
    }

    const newDefaultVariant = resolveDefaultVariant(doc, lease.payload.value);
    doc.set("defaultVariant", newDefaultVariant);
    const updatedYaml = doc.toString();

    // 5. Get base branch commit SHA and create promotion branch (with 422 branch race handling)
    const baseSha = await this.client.getBranchSha(owner, repo, baseBranch);
    const branchName = `synapse/promote-lease-${lease_id}`;
    try {
      await this.client.createBranch(owner, repo, branchName, baseSha);
    } catch (err: unknown) {
      const is422 = (err as { status?: number }).status === 422;
      const msg = err instanceof Error ? err.message : String(err);
      if (is422 || msg.toLowerCase().includes("already exists")) {
        throw new StalePrConflictError(
          `Promotion branch "${branchName}" already exists for lease ${lease_id}`,
        );
      }
      throw err;
    }

    // 6. Commit updated flag YAML file to branch
    const commitMessage = `feat(flags): promote override for ${flag_key} in ${env} (lease ${lease_id})`;
    await this.client.createOrUpdateFile(owner, repo, {
      path: filePath,
      message: commitMessage,
      content: updatedYaml,
      branch: branchName,
      sha: existingFile.sha,
    });

    // 7. Open GitHub Draft Pull Request with incident metadata & dual-control notice
    const prTitle = `feat(flags): promote override for ${flag_key} in ${env} (lease ${lease_id})`;
    const prBody = `## SynapseState Git Reconciliation (Dual-Control Promotion)

This pull request reconciles an emergency override back to the Git baseline configuration.

### Override Details
- **Target Flag:** \`${flag_key}\`
- **Environment:** \`${env}\`
- **Emergency Lease ID:** \`${lease_id}\`
- **Authorized Operator:** \`${lease.payload.kid}\`
- **Incident Reason:** ${lease.payload.reason}
- **Issued At:** \`${lease.payload.issued_at}\`
- **TTL:** \`${lease.payload.ttl_seconds}s\`
- **Promoted Variant / Value:** \`${JSON.stringify(newDefaultVariant)}\`

---

> [!IMPORTANT]
> **Dual-Control Peer Review Required**  
> In accordance with Architectural Invariant 4, this change requires human review and merge.  
> Merging this PR will reconcile the Git baseline and transition emergency lease \`${lease_id}\` to \`PROMOTED\` via webhook.
`;

    const pr = await this.client.createPullRequest(owner, repo, {
      title: prTitle,
      body: prBody,
      head: branchName,
      base: baseBranch,
      draft: true,
    });

    return {
      lease_id,
      pr_url: pr.html_url,
      branch: branchName,
      number: pr.number,
    };
  }
}
