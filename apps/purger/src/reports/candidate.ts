/**
 * Structured Candidate Report Generator for SynapseState Purger.
 *
 * Produces human-readable and machine-readable artifacts for qualified stale
 * feature flags, including exact call sites, Uber Piranha configuration, and
 * GritQL transformation rules.
 *
 * Implements authoritative requirements from:
 * - AGENTS.md (§1 Non-Goals, §2 Architectural Invariants 1-8)
 * - docs/ARCHITECTURE.md (§9 Telemetry-Driven Stale Detection & Scanner)
 * - docs/ROADMAP.md (§5 Phase 5, Deliverable 5.3 & PR 23)
 */

import type { CandidateFlag } from "../qualification/types.js";
import type { CallSite, ConsumerCrossReference, OpenFeatureEvalMethod } from "../scanner/types.js";
import type {
  CallSiteReportRow,
  CandidateReport,
  GritQLPattern,
  PiranhaConfig,
  VariantDataType,
} from "./types.js";

/**
 * Infers the literal data type of a winning variant string.
 */
export function inferVariantType(variant: string): VariantDataType {
  const trimmed = variant.trim();
  if (trimmed === "true" || trimmed === "false") {
    return "boolean";
  }
  if (!isNaN(Number(trimmed)) && trimmed !== "") {
    return "number";
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return "object";
  }
  return "string";
}

/**
 * Formats scope context into a human-readable identifier.
 */
export function formatScopeDescription(scope: CallSite["scope"]): string {
  if (scope.className && scope.functionName) {
    return `${scope.className}.${scope.functionName}()`;
  }
  if (scope.functionName) {
    return `${scope.functionName}()`;
  }
  if (scope.className) {
    return `${scope.className} (anonymous)`;
  }
  return `anonymous (${scope.kind})`;
}

/**
 * Converts an AST CallSite into a clean report table row.
 */
export function formatCallSiteReportRow(site: CallSite): CallSiteReportRow {
  const loc = site.location;
  const locationString = `${loc.filePath}:${loc.startLine}:${loc.startColumn}-${loc.endLine}:${loc.endColumn}`;

  return {
    filePath: loc.filePath,
    startLine: loc.startLine,
    endLine: loc.endLine,
    startColumn: loc.startColumn,
    endColumn: loc.endColumn,
    locationString,
    scopeDescription: formatScopeDescription(site.scope),
    methodName: site.methodName,
    defaultValueText: site.defaultValueText ?? "N/A",
    serviceName: site.serviceName ?? "unknown",
    fullCallText: site.fullCallText,
  };
}

/**
 * Builds an Uber Piranha configuration mapping for the candidate flag.
 */
export function buildPiranhaConfig(
  flagKey: string,
  winningVariant: string,
  variantType: VariantDataType,
  methods: OpenFeatureEvalMethod[]
): PiranhaConfig {
  const piranhaType = variantType === "unknown" ? "string" : variantType;
  const treatedComplement =
    variantType === "boolean"
      ? winningVariant.trim() === "true"
        ? "false"
        : "true"
      : undefined;

  const methodNames = methods.length > 0
    ? Array.from(new Set(methods)).sort()
    : ["getBooleanValue", "getBooleanDetails"];

  return {
    language: "typescript",
    flagName: flagKey,
    flagType: piranhaType,
    treated: winningVariant,
    ...(treatedComplement !== undefined ? { treatedComplement } : {}),
    methodNames,
  };
}

/**
 * Builds a declarative GritQL pattern definition for AST rewriting.
 */
export function buildGritQLPattern(
  flagKey: string,
  winningVariant: string,
  variantType: VariantDataType,
  methods: OpenFeatureEvalMethod[]
): GritQLPattern {
  const methodList = methods.length > 0
    ? Array.from(new Set(methods)).sort()
    : ["getBooleanValue", "getBooleanDetails", "getStringValue", "getStringDetails"];

  const methodOrClause = methodList.map((m) => `\`${m}\``).join(", ");
  const replacement = variantType === "string" ? `'${winningVariant}'` : winningVariant;

  const pattern = `engine grit(0.1)
language js

\`$client.$method("${flagKey}", $default)\` where {
  $method <: or { ${methodOrClause} }
} => ${replacement}`;

  return {
    engine: "grit(0.1)",
    language: "js",
    flagKey,
    winningVariant,
    pattern,
    targetMethods: methodList,
  };
}

/**
 * Options for generating a candidate report.
 */
export interface CreateCandidateReportOptions {
  candidate: CandidateFlag;
  crossReference: ConsumerCrossReference;
  now?: Date | string;
}

/**
 * Generates a complete CandidateReport data model from a qualified flag and AST cross-reference.
 */
export function createCandidateReport(options: CreateCandidateReportOptions): CandidateReport {
  const { candidate, crossReference, now } = options;
  const timestamp = now
    ? typeof now === "string"
      ? now
      : now.toISOString()
    : new Date().toISOString();

  const variantType = inferVariantType(candidate.winningVariant);
  const callSiteRows = crossReference.callSites.map(formatCallSiteReportRow);
  const detectedMethods = crossReference.callSites.map((c) => c.methodName);

  const piranha = buildPiranhaConfig(
    candidate.flagKey,
    candidate.winningVariant,
    variantType,
    detectedMethods
  );

  const gritql = buildGritQLPattern(
    candidate.flagKey,
    candidate.winningVariant,
    variantType,
    detectedMethods
  );

  return {
    flagKey: candidate.flagKey,
    env: candidate.env,
    winningVariant: candidate.winningVariant,
    winningVariantType: variantType,
    totalEvaluations: candidate.totalEvaluations,
    evaluatingServices: [...candidate.evaluatingServices].sort(),
    windowDays: candidate.windowDays,
    ...(candidate.firstSeen || candidate.lastSeen
      ? {
          observationSpan: {
            firstSeen: candidate.firstSeen,
            lastSeen: candidate.lastSeen,
          },
        }
      : {}),
    totalCallSites: callSiteRows.length,
    callSites: callSiteRows,
    toolConfigs: {
      piranha,
      gritql,
    },
    generatedAt: timestamp,
  };
}

/**
 * Formats a CandidateReport into GitHub-flavored Markdown.
 */
export function formatCandidateReportMarkdown(report: CandidateReport): string {
  const lines: string[] = [];

  lines.push(`# Stale Feature Flag Candidate: \`${report.flagKey}\``);
  lines.push("");
  lines.push(`> **Status:** QUALIFIED FOR RETIREMENT  `);
  lines.push(`> **Environment:** \`${report.env}\`  `);
  lines.push(`> **Generated At:** ${report.generatedAt}`);
  lines.push("");
  lines.push("## Telemetry Summary");
  lines.push("");
  lines.push("| Dimension | Value |");
  lines.push("|---|---|");
  lines.push(`| Flag Key | \`${report.flagKey}\` |`);
  lines.push(`| Winning Variant | \`${report.winningVariant}\` (${report.winningVariantType}) |`);
  lines.push(`| Total Evaluations | ${report.totalEvaluations.toLocaleString()} |`);
  lines.push(`| Window Days | ${report.windowDays} days |`);
  lines.push(`| Evaluating Services | ${report.evaluatingServices.map((s) => `\`${s}\``).join(", ")} |`);
  if (report.observationSpan?.firstSeen && report.observationSpan?.lastSeen) {
    lines.push(`| Observation Span | ${report.observationSpan.firstSeen} to ${report.observationSpan.lastSeen} |`);
  }
  lines.push("");

  lines.push(`## AST Call Sites (${report.totalCallSites})`);
  lines.push("");
  if (report.callSites.length === 0) {
    lines.push("_No call sites detected in scanned source files._");
  } else {
    lines.push("| Service | File Path | Line | Method | Default Value | Enclosing Scope |");
    lines.push("|---|---|---|---|---|---|");
    for (const site of report.callSites) {
      lines.push(
        `| \`${site.serviceName}\` | \`${site.filePath}\` | ${site.startLine}:${site.startColumn} | \`${site.methodName}\` | \`${site.defaultValueText}\` | ${site.scopeDescription} |`
      );
    }
  }
  lines.push("");

  lines.push("## Automated Refactoring Tool Configurations");
  lines.push("");
  lines.push("### Uber Piranha Configuration (`piranha_arguments.json`)");
  lines.push("```json");
  lines.push(JSON.stringify(report.toolConfigs.piranha, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### GritQL Pattern Query (`rules.grit`)");
  lines.push("```grit");
  lines.push(report.toolConfigs.gritql.pattern);
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

/**
 * Formats a CandidateReport for CLI output.
 */
export function formatCandidateReportCli(report: CandidateReport): string {
  const lines: string[] = [];

  lines.push(`================================================================================`);
  lines.push(`CANDIDATE: ${report.flagKey} [${report.env}]`);
  lines.push(`================================================================================`);
  lines.push(`Winning Variant: ${report.winningVariant} (${report.winningVariantType})`);
  lines.push(`Evaluations:     ${report.totalEvaluations.toLocaleString()} across ${report.windowDays} days`);
  lines.push(`Services:        ${report.evaluatingServices.join(", ")}`);
  lines.push(`Call Sites (${report.totalCallSites}):`);

  for (const site of report.callSites) {
    lines.push(`  - [${site.serviceName}] ${site.locationString} in ${site.scopeDescription}`);
    lines.push(`    Call: ${site.fullCallText}`);
  }

  return lines.join("\n");
}

/**
 * Serializes CandidateReport to indented JSON.
 */
export function formatCandidateReportJson(report: CandidateReport): string {
  return JSON.stringify(report, null, 2);
}
