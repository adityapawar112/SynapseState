/**
 * Structured Refusal Report Generator for SynapseState Purger.
 *
 * Produces structured and human-readable refusal reports when a feature flag
 * fails qualification or AST consistency verification (e.g. silent services,
 * dynamic non-literal keys, or undeclared callers).
 *
 * Implements authoritative requirements from:
 * - AGENTS.md (§1 Non-Goals, §2 Architectural Invariants 1-8)
 * - docs/ARCHITECTURE.md (§9 Telemetry-Driven Stale Detection & Scanner)
 * - docs/ROADMAP.md (§5 Phase 5, Deliverable 5.3 & PR 23)
 */

import type { DisqualificationReason, QualificationResult } from "../qualification/types.js";
import type { ConsumerCrossReference, RefusalMarker } from "../scanner/types.js";
import type { RefusalItem, RefusalOrigin, RefusalReport } from "./types.js";

/**
 * Options for generating a refusal report from qualification results.
 */
export interface CreateQualificationRefusalOptions {
  qualificationResult: QualificationResult;
  now?: Date | string;
}

/**
 * Maps a DisqualificationReason to an actionable RefusalItem.
 */
export function mapDisqualificationReasonToItem(
  reason: DisqualificationReason,
  flagKey: string,
  blockingServices?: string[]
): RefusalItem {
  switch (reason) {
    case "BLOCKED_BY_SILENT_SERVICE": {
      const services = blockingServices && blockingServices.length > 0 ? blockingServices : ["unknown-service"];
      const serviceListStr = services.map((s) => `'${s}'`).join(", ");
      const firstService = services[0];

      return {
        code: "BLOCKED_BY_SILENT_SERVICE",
        title: "Blocked by Silent Consumer Service",
        blockingServices: services,
        message: `Evaluating consumer service(s) ${serviceListStr} have stopped reporting evaluation telemetry (>14 days silent). Purging is blocked to prevent breaking silent workloads.`,
        remediation: `synapse service retire --service ${firstService}`,
      };
    }

    case "ACTIVE_LEASE_EXISTS":
      return {
        code: "ACTIVE_LEASE_EXISTS",
        title: "Active Emergency Lease Exists",
        message: `Flag '${flagKey}' has an active emergency override lease or un-finalized promotion. Flag cannot be retired while overrides are in flight.`,
        remediation: `synapse lease revoke --flag ${flagKey}`,
      };

    case "MULTI_VARIANT_ACTIVE":
      return {
        code: "MULTI_VARIANT_ACTIVE",
        title: "Multiple Active Variants in Window",
        message: `Flag '${flagKey}' served multiple variants during the observation window. Stale candidate qualification requires an invariant single variant.`,
        remediation: `Wait until rollout stabilizes and telemetry reflects 100% distribution for a single variant across the full window.`,
      };

    case "INSUFFICIENT_WINDOW":
      return {
        code: "INSUFFICIENT_WINDOW",
        title: "Insufficient Observation Window",
        message: `Flag '${flagKey}' does not satisfy the minimum required continuous observation window (default: 35 days).`,
        remediation: `Allow telemetry accumulation to continue until the required window threshold is satisfied.`,
      };

    case "EXCLUDED_LIFECYCLE_CLASS":
      return {
        code: "EXCLUDED_LIFECYCLE_CLASS",
        title: "Excluded Flag Lifecycle Class",
        message: `Flag '${flagKey}' belongs to an excluded lifecycle class (e.g. permanent or killswitch). Only 'release' flags are eligible for retirement.`,
        remediation: `Update flag lifecycle class to 'release' in Git configuration if intended for retirement.`,
      };

    case "UNREGISTERED_FLAG":
      return {
        code: "UNREGISTERED_FLAG",
        title: "Unregistered Feature Flag",
        message: `Flag '${flagKey}' was evaluated by services but is not declared in the central flag registry.`,
        remediation: `Register flag in Git baseline or verify flag key spelling.`,
      };

    case "MISSING_DEFAULT_VARIANT":
      return {
        code: "MISSING_DEFAULT_VARIANT",
        title: "Missing Default Variant",
        message: `Flag '${flagKey}' does not define a fallback default variant in registry configuration.`,
        remediation: `Specify default variant in Git flag configuration.`,
      };

    default:
      return {
        code: reason,
        title: "Disqualified Flag",
        message: `Flag '${flagKey}' failed qualification criteria with reason: ${reason}.`,
        remediation: `Review flag telemetry and configuration against qualification policies.`,
      };
  }
}

/**
 * Creates a RefusalReport from a disqualified flag qualification result.
 */
export function createRefusalReportFromQualification(
  options: CreateQualificationRefusalOptions
): RefusalReport {
  const { qualificationResult, now } = options;
  const timestamp = now
    ? typeof now === "string"
      ? now
      : now.toISOString()
    : new Date().toISOString();

  const reasons = qualificationResult.reasons.map((reason) =>
    mapDisqualificationReasonToItem(
      reason,
      qualificationResult.flagKey,
      qualificationResult.blockingServices
    )
  );

  const summary = `Flag '${qualificationResult.flagKey}' [${qualificationResult.env}] failed qualification with ${reasons.length} refusal reason(s).`;

  return {
    flagKey: qualificationResult.flagKey,
    env: qualificationResult.env,
    refusalOrigin: "QUALIFICATION",
    isBlocked: true,
    reasons,
    summary,
    generatedAt: timestamp,
  };
}

/**
 * Maps a scanner RefusalMarker into a RefusalItem.
 */
export function mapRefusalMarkerToItem(marker: RefusalMarker): RefusalItem {
  const locStr = `${marker.location.filePath}:${marker.location.startLine}:${marker.location.startColumn}`;

  switch (marker.reason) {
    case "NON_LITERAL_FLAG_KEY":
      return {
        code: "NON_LITERAL_FLAG_KEY",
        title: "Non-Literal Dynamic Flag Key",
        location: marker.location,
        nodeSnippet: marker.nodeText,
        message: marker.message,
        remediation: `Refactor dynamic flag key expression at ${locStr} to a static string literal constant.`,
      };

    case "MISSING_ARGUMENTS":
      return {
        code: "MISSING_ARGUMENTS",
        title: "Missing Evaluation Arguments",
        location: marker.location,
        nodeSnippet: marker.nodeText,
        message: marker.message,
        remediation: `Provide flag key string literal and fallback default value at ${locStr}.`,
      };

    case "MISSING_DEFAULT_VALUE":
      return {
        code: "MISSING_DEFAULT_VALUE",
        title: "Missing Default Value",
        location: marker.location,
        nodeSnippet: marker.nodeText,
        message: marker.message,
        remediation: `Supply fallback default value parameter to OpenFeature evaluation method at ${locStr}.`,
      };

    case "UNDECLARED_CONSUMER_SERVICE":
      return {
        code: "UNDECLARED_CONSUMER_SERVICE",
        title: "Undeclared Consumer Service in AST",
        location: marker.location,
        nodeSnippet: marker.nodeText,
        message: marker.message,
        remediation: `Ensure OpenFeature TelemetryHook is active in the undeclared consumer service or retire orphan call sites before automated cleanup.`,
      };

    case "SCAN_ERROR":
      return {
        code: "SCAN_ERROR",
        title: "AST Parsing or Analysis Error",
        location: marker.location,
        nodeSnippet: marker.nodeText,
        message: marker.message,
        remediation: `Investigate syntax or parser error at ${locStr}.`,
      };

    default:
      return {
        code: marker.reason,
        title: "Scanner Refusal",
        location: marker.location,
        nodeSnippet: marker.nodeText,
        message: marker.message,
        remediation: `Review source code at ${locStr}.`,
      };
  }
}

/**
 * Options for generating a refusal report from an AST cross-reference.
 */
export interface CreateCrossReferenceRefusalOptions {
  crossReference: ConsumerCrossReference;
  env: string;
  now?: Date | string;
}

/**
 * Creates a RefusalReport from an inconsistent AST consumer cross-reference.
 */
export function createRefusalReportFromCrossReference(
  options: CreateCrossReferenceRefusalOptions
): RefusalReport {
  const { crossReference, env, now } = options;
  const timestamp = now
    ? typeof now === "string"
      ? now
      : now.toISOString()
    : new Date().toISOString();

  const items: RefusalItem[] = [];

  // Map scanner refusal markers (e.g. non-literal keys, missing arguments, undeclared services)
  for (const marker of crossReference.refusals) {
    items.push(mapRefusalMarkerToItem(marker));
  }

  // Map undeclared consumer services (if not already covered by refusal markers)
  if (crossReference.undeclaredServices.length > 0) {
    const hasUndeclaredMarker = items.some((i) => i.code === "UNDECLARED_CONSUMER_SERVICE");
    if (!hasUndeclaredMarker) {
      const serviceList = crossReference.undeclaredServices.join(", ");
      items.push({
        code: "UNDECLARED_CONSUMER_SERVICE",
        title: "Undeclared Consumer Service in AST",
        blockingServices: crossReference.undeclaredServices,
        message: `Static AST scanning detected flag evaluation in service(s) [${serviceList}], but zero telemetry evaluations were recorded in environment '${env}'.`,
        remediation: `Ensure OpenFeature TelemetryHook is active in service(s) [${serviceList}] or retire orphan call sites before automated cleanup.`,
      });
    }
  }

  // Fallback if marked inconsistent without explicit reasons
  if (items.length === 0) {
    items.push({
      code: "CONSISTENCY_MISMATCH",
      title: "AST Consumer Cross-Reference Mismatch",
      message: `AST consumers [${crossReference.astConsumerServices.join(", ")}] did not match telemetry evaluated services [${crossReference.evaluatingServices.join(", ")}].`,
      remediation: `Reconcile service deployment topology with recorded telemetry heartbeats.`,
    });
  }

  const hasScannerSpecific = crossReference.refusals.some(
    (m) =>
      m.reason === "NON_LITERAL_FLAG_KEY" ||
      m.reason === "SCAN_ERROR" ||
      m.reason === "MISSING_ARGUMENTS" ||
      m.reason === "MISSING_DEFAULT_VALUE"
  );
  const origin: RefusalOrigin = hasScannerSpecific ? "SCANNER" : "CROSS_REFERENCE";
  const summary = `Flag '${crossReference.flagKey}' [${env}] refused during ${origin.toLowerCase()} phase with ${items.length} issue(s).`;

  return {
    flagKey: crossReference.flagKey,
    env,
    refusalOrigin: origin,
    isBlocked: true,
    reasons: items,
    summary,
    generatedAt: timestamp,
  };
}

/**
 * Formats a RefusalReport as GitHub-flavored Markdown.
 */
export function formatRefusalReportMarkdown(report: RefusalReport): string {
  const lines: string[] = [];

  lines.push(`# Refusal Report: \`${report.flagKey}\``);
  lines.push("");
  lines.push(`> **Status:** DISQUALIFIED / REFUSED  `);
  lines.push(`> **Environment:** \`${report.env}\`  `);
  lines.push(`> **Origin:** \`${report.refusalOrigin}\`  `);
  lines.push(`> **Generated At:** ${report.generatedAt}`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(report.summary);
  lines.push("");
  lines.push(`## Refusal Reasons (${report.reasons.length})`);
  lines.push("");

  for (let i = 0; i < report.reasons.length; i++) {
    const item = report.reasons[i];
    lines.push(`### ${i + 1}. ${item.title} (\`${item.code}\`)`);
    lines.push("");
    lines.push(`**Description:** ${item.message}`);
    lines.push("");

    if (item.blockingServices && item.blockingServices.length > 0) {
      lines.push(`**Blocking Service(s):** ${item.blockingServices.map((s) => `\`${s}\``).join(", ")}`);
      lines.push("");
    }

    if (item.location) {
      lines.push(
        `**Source Location:** \`${item.location.filePath}:${item.location.startLine}:${item.location.startColumn}\``
      );
      lines.push("");
    }

    if (item.nodeSnippet) {
      lines.push("**AST Code Snippet:**");
      lines.push("```typescript");
      lines.push(item.nodeSnippet);
      lines.push("```");
      lines.push("");
    }

    lines.push(`> **Remediation:** \`${item.remediation}\``);
    lines.push("");
  }

  lines.push("## Operator Remediation Checklist");
  lines.push("");
  for (const item of report.reasons) {
    lines.push(`- [ ] **[${item.code}]** ${item.remediation}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Formats a RefusalReport for CLI output.
 */
export function formatRefusalReportCli(report: RefusalReport): string {
  const lines: string[] = [];

  lines.push(`================================================================================`);
  lines.push(`REFUSAL: ${report.flagKey} [${report.env}] (Origin: ${report.refusalOrigin})`);
  lines.push(`================================================================================`);
  lines.push(report.summary);
  lines.push("");

  for (let i = 0; i < report.reasons.length; i++) {
    const item = report.reasons[i];
    lines.push(`[${i + 1}] ${item.title} (${item.code})`);
    lines.push(`    Message:     ${item.message}`);
    if (item.location) {
      lines.push(`    Location:    ${item.location.filePath}:${item.location.startLine}:${item.location.startColumn}`);
    }
    if (item.nodeSnippet) {
      lines.push(`    Snippet:     ${item.nodeSnippet}`);
    }
    lines.push(`    Remediation: ${item.remediation}`);
  }

  return lines.join("\n");
}

/**
 * Serializes RefusalReport to indented JSON.
 */
export function formatRefusalReportJson(report: RefusalReport): string {
  return JSON.stringify(report, null, 2);
}
