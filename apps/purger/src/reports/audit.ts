/**
 * Purger Audit Pipeline Orchestrator.
 *
 * Connects telemetry qualification, AST codebase scanning, consumer cross-referencing,
 * and structured report emission into an end-to-end automated audit run.
 *
 * Implements authoritative requirements from:
 * - AGENTS.md (§1 Non-Goals, §2 Architectural Invariants 1-8)
 * - docs/ARCHITECTURE.md (§9 Telemetry-Driven Stale Detection & Scanner)
 * - docs/ROADMAP.md (§5 Phase 5, Deliverable 5.3 & PR 23)
 */

import { evaluateCandidateQuiescence } from "../qualification/engine.js";
import { crossReferenceConsumers, scanCodebase } from "../scanner/scanner.js";
import type { CodebaseScanResult } from "../scanner/types.js";
import { createCandidateReport, formatCandidateReportCli, formatCandidateReportMarkdown } from "./candidate.js";
import { createRefusalReportFromCrossReference, createRefusalReportFromQualification, formatRefusalReportCli, formatRefusalReportMarkdown } from "./refusal.js";
import type { CandidateReport, PurgerAuditOptions, PurgerAuditResult, RefusalReport } from "./types.js";

/**
 * Creates an empty CodebaseScanResult when no scan target is provided.
 */
function createEmptyScanResult(): CodebaseScanResult {
  return {
    totalFilesScanned: 0,
    totalCallSites: 0,
    callSites: [],
    flagReferences: {},
    unresolvedCallSites: [],
    unresolvedCallSitesByService: {},
    unresolvedServices: [],
    refusals: [],
  };
}

/**
 * Executes a complete purger audit across telemetry snapshots and application source files.
 */
export function runPurgerAudit(options: PurgerAuditOptions): PurgerAuditResult {
  const {
    snapshots,
    qualificationOptions,
    scanResult: providedScanResult,
    scannerOptions,
    allowUnreferencedServices,
    now,
  } = options;

  const timestamp = now
    ? typeof now === "string"
      ? now
      : now.toISOString()
    : new Date().toISOString();

  // Obtain or run codebase AST scan
  let scanResult: CodebaseScanResult;
  if (providedScanResult) {
    scanResult = providedScanResult;
  } else if (scannerOptions) {
    scanResult = scanCodebase(scannerOptions);
  } else {
    scanResult = createEmptyScanResult();
  }

  const candidates: CandidateReport[] = [];
  const refusals: RefusalReport[] = [];

  for (const snapshot of snapshots) {
    const qualResult = evaluateCandidateQuiescence(snapshot, qualificationOptions);

    if (qualResult.status === "DISQUALIFIED") {
      const refusalReport = createRefusalReportFromQualification({
        qualificationResult: qualResult,
        now: timestamp,
      });
      refusals.push(refusalReport);
      continue;
    }

    if (qualResult.candidate) {
      const crossRefs = crossReferenceConsumers({
        candidates: [qualResult.candidate],
        scanResult,
        allowUnreferencedServices,
      });

      const crossRef = crossRefs[0];
      if (crossRef && crossRef.isConsistent) {
        const candidateReport = createCandidateReport({
          candidate: qualResult.candidate,
          crossReference: crossRef,
          now: timestamp,
        });
        candidates.push(candidateReport);
      } else if (crossRef) {
        const refusalReport = createRefusalReportFromCrossReference({
          crossReference: crossRef,
          env: qualResult.env,
          now: timestamp,
        });
        refusals.push(refusalReport);
      }
    }
  }

  const totalCallSitesFound = candidates.reduce((acc, c) => acc + c.totalCallSites, 0);

  return {
    candidates,
    refusals,
    summary: {
      totalEvaluated: snapshots.length,
      totalQualified: candidates.length,
      totalRefused: refusals.length,
      totalCallSitesFound,
    },
    generatedAt: timestamp,
  };
}

/**
 * Formats a full audit result into Markdown for GitHub Actions summaries or PR bodies.
 */
export function formatPurgerAuditMarkdown(audit: PurgerAuditResult): string {
  const lines: string[] = [];

  lines.push("# SynapseState Purger Audit Report");
  lines.push("");
  lines.push(`> **Generated At:** ${audit.generatedAt}`);
  lines.push("");
  lines.push("## Summary Statistics");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|---|---|");
  lines.push(`| Total Evaluated Flags | ${audit.summary.totalEvaluated} |`);
  lines.push(`| Qualified Candidates | ${audit.summary.totalQualified} |`);
  lines.push(`| Refused / Disqualified | ${audit.summary.totalRefused} |`);
  lines.push(`| Total Discovered Call Sites | ${audit.summary.totalCallSitesFound} |`);
  lines.push("");

  if (audit.candidates.length > 0) {
    lines.push(`## Qualified Stale Candidates (${audit.candidates.length})`);
    lines.push("");
    for (const cand of audit.candidates) {
      lines.push(formatCandidateReportMarkdown(cand));
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  if (audit.refusals.length > 0) {
    lines.push(`## Refused / Disqualified Flags (${audit.refusals.length})`);
    lines.push("");
    for (const ref of audit.refusals) {
      lines.push(formatRefusalReportMarkdown(ref));
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Formats a full audit result for CLI terminal output.
 */
export function formatPurgerAuditCli(audit: PurgerAuditResult): string {
  const lines: string[] = [];

  lines.push(`================================================================================`);
  lines.push(`SYNAPSESTATE PURGER AUDIT [${audit.generatedAt}]`);
  lines.push(`================================================================================`);
  lines.push(`Evaluated: ${audit.summary.totalEvaluated} | Qualified: ${audit.summary.totalQualified} | Refused: ${audit.summary.totalRefused} | Call Sites: ${audit.summary.totalCallSitesFound}`);
  lines.push("");

  if (audit.candidates.length > 0) {
    lines.push(`--- QUALIFIED CANDIDATES (${audit.candidates.length}) ---`);
    for (const cand of audit.candidates) {
      lines.push(formatCandidateReportCli(cand));
      lines.push("");
    }
  }

  if (audit.refusals.length > 0) {
    lines.push(`--- REFUSALS (${audit.refusals.length}) ---`);
    for (const ref of audit.refusals) {
      lines.push(formatRefusalReportCli(ref));
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Serializes audit result to JSON.
 */
export function formatPurgerAuditJson(audit: PurgerAuditResult): string {
  return JSON.stringify(audit, null, 2);
}
