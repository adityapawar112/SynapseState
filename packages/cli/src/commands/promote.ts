import type { Command } from "commander";
import pc from "picocolors";
import { ULID_REGEX } from "@synapsestate/lease";

export interface PromoteParams {
  leaseId: string;
  env?: string;
  apiUrl?: string;
  token?: string;
  json?: boolean;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface PromoteResult {
  leaseId: string;
  prUrl: string;
  branch: string;
  formattedOutput: string;
}

/**
 * Executes emergency lease promotion to Git baseline via Control API.
 * Opens a dual-control GitHub Pull Request.
 */
export async function executePromote(
  params: PromoteParams,
): Promise<PromoteResult> {
  const { leaseId } = params;

  // 1. Strict ULID validation
  if (!ULID_REGEX.test(leaseId)) {
    throw new Error(
      `Invalid lease ID "${leaseId}". Expected a 26-character Crockford ULID.`,
    );
  }

  const apiUrl = (
    params.apiUrl ||
    process.env.SYNAPSE_API_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");

  const token = params.token || process.env.SYNAPSE_API_TOKEN;
  const fetchFn = params.fetchFn ?? fetch;

  const url = `${apiUrl}/v1/leases/${encodeURIComponent(leaseId)}/promote`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const timeoutMs = params.timeoutMs ?? 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(params.env ? { env: params.env } : {}),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (
      (err as { name?: string }).name === "AbortError" ||
      (err as { name?: string }).name === "TimeoutError"
    ) {
      throw new Error(
        `Control API request timed out after ${timeoutMs}ms while contacting ${apiUrl}.`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Control API unreachable at ${apiUrl} (${msg}). Ensure Control API is running.`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    throw new Error(
      "Authentication failed (HTTP 401). Provide a valid operator token via --token or SYNAPSE_API_TOKEN.",
    );
  }

  if (res.status === 403) {
    throw new Error(
      "Forbidden (HTTP 403). API token does not have operator or admin role required to promote overrides.",
    );
  }

  if (res.status === 404) {
    throw new Error(`Emergency lease "${leaseId}" not found (HTTP 404).`);
  }

  if (res.status === 400) {
    let errBody: { error?: string; message?: string } = {};
    try {
      errBody = (await res.json()) as typeof errBody;
    } catch {
      // ignore
    }
    throw new Error(
      errBody.message || `Bad request (HTTP 400): ${JSON.stringify(errBody)}`,
    );
  }

  if (res.status === 409) {
    let errorData: {
      error?: string;
      message?: string;
      existing_pr_url?: string;
    } = {};
    try {
      errorData = (await res.json()) as typeof errorData;
    } catch {
      // Fallback
    }

    if (errorData.error === "STALE_PR_CONFLICT") {
      throw new Error(
        `Promotion conflict (HTTP 409): ${errorData.message || "An open pull request already exists for this flag baseline"}. Existing PR: ${errorData.existing_pr_url || "unknown"}`,
      );
    }

    throw new Error(
      `Promotion conflict (HTTP 409): ${errorData.message || "Lease is not in a promotable state"}`,
    );
  }

  if (!res.ok) {
    let serverMessage = res.statusText;
    try {
      const errBody = (await res.json()) as {
        message?: string;
        error?: string;
      };
      serverMessage = errBody.message || errBody.error || serverMessage;
    } catch {
      // Fallback
    }
    throw new Error(
      `Failed to promote lease (HTTP ${res.status}): ${serverMessage}`,
    );
  }

  const data = (await res.json()) as {
    lease_id: string;
    pr_url: string;
    branch: string;
  };

  let formattedOutput = "";
  if (params.json) {
    formattedOutput = JSON.stringify(data, null, 2);
  } else {
    formattedOutput = [
      "",
      pc.green("✓ Emergency Lease Promotion Initiated!"),
      pc.dim("--------------------------------------------------"),
      `${pc.bold("Lease ID:")}     ${data.lease_id}`,
      `${pc.bold("Pull Request:")} ${pc.cyan(data.pr_url)}`,
      `${pc.bold("Branch:")}       ${data.branch}`,
      pc.dim("--------------------------------------------------"),
      pc.bold("NEXT STEPS (Dual-Control Invariant 4):"),
      "1. A peer operator or code owner must review and merge the pull request.",
      `2. Merging the PR serves as mandatory secondary approval, reconciling the Git baseline`,
      `   and automatically transitioning emergency lease ${data.lease_id} to PROMOTED via webhook.`,
      "",
    ].join("\n");
  }

  return {
    leaseId: data.lease_id,
    prUrl: data.pr_url,
    branch: data.branch,
    formattedOutput,
  };
}

/**
 * Registers the `synapse promote` CLI command.
 */
export function registerPromoteCommands(program: Command): void {
  program
    .command("promote")
    .description(
      "Promote an emergency override to the Git baseline by opening a dual-control Git reconciliation Pull Request",
    )
    .argument(
      "<lease_id>",
      "26-character Crockford ULID of the emergency lease to promote",
    )
    .option(
      "-e, --env <env>",
      "Target environment (defaults to production or SYNAPSE_ENV)",
    )
    .option(
      "-u, --api-url <url>",
      "Control API base URL (defaults to SYNAPSE_API_URL or http://localhost:3000)",
    )
    .option(
      "-t, --token <token>",
      "Operator API bearer token (defaults to SYNAPSE_API_TOKEN)",
    )
    .option("--json", "Output machine-readable JSON result")
    .action(async (leaseId: string, options) => {
      try {
        const result = await executePromote({
          leaseId,
          env: options.env,
          apiUrl: options.apiUrl,
          token: options.token,
          json: options.json,
        });
        console.log(result.formattedOutput);
      } catch (err: unknown) {
        console.error(pc.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
