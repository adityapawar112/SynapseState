/**
 * Domain Models for SynapseState Purger Candidate & Refusal Reports.
 *
 * Implements authoritative domain vocabulary and data contracts as defined in:
 * - AGENTS.md (§1 Non-Goals, §2 Architectural Invariants 1-8)
 * - docs/ARCHITECTURE.md (§9 Telemetry-Driven Stale Detection & Scanner, §10 Security Threat Model)
 * - docs/ROADMAP.md (§5 Phase 5, Deliverable 5.3 & PR 23)
 * - GLOSSARY.md
 */

import type {
  DisqualificationReason,
  FlagTelemetrySnapshot,
  QualificationOptions,
} from "../qualification/types.js";
import type {
  CodebaseScanResult,
  OpenFeatureEvalMethod,
  ScannerOptions,
  ScannerRefusalReason,
  SourceLocation,
} from "../scanner/types.js";

/**
 * Supported variant literal data types.
 */
export type VariantDataType = "boolean" | "string" | "number" | "object";

/**
 * Call site summary row specifically formatted for report tables and diff generation.
 */
export interface CallSiteReportRow {
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  locationString: string;
  scopeDescription: string;
  methodName: OpenFeatureEvalMethod;
  defaultValueText: string;
  serviceName: string;
  fullCallText: string;
}

/**
 * Uber Piranha flag configuration mapping for automated AST rewriting.
 */
export interface PiranhaConfig {
  language: "typescript" | "javascript";
  flagName: string;
  flagType: "boolean" | "string" | "number" | "object";
  treated: string;
  treatedComplement?: string;
  methodNames: string[];
}

/**
 * GritQL pattern query definition for declarative AST transformations.
 */
export interface GritQLPattern {
  engine: "grit(0.1)";
  language: "typescript";
  flagKey: string;
  winningVariant: string;
  pattern: string;
  targetMethods: string[];
}

/**
 * Structured candidate report for a qualified stale feature flag.
 */
export interface CandidateReport {
  flagKey: string;
  env: string;
  winningVariant: string;
  winningVariantType: VariantDataType;
  totalEvaluations: number;
  evaluatingServices: string[];
  windowDays: number;
  observationSpan?: {
    firstSeen?: string;
    lastSeen?: string;
  };
  totalCallSites: number;
  callSites: CallSiteReportRow[];
  toolConfigs: {
    piranha: PiranhaConfig;
    gritql: GritQLPattern;
  };
  generatedAt: string;
}

/**
 * Categorical origin indicating which pipeline phase triggered the refusal.
 */
export type RefusalOrigin = "QUALIFICATION" | "SCANNER" | "CROSS_REFERENCE";

/**
 * Detailed refusal reason item with actionable remediation.
 */
export interface RefusalItem {
  code: DisqualificationReason | ScannerRefusalReason | "CONSISTENCY_MISMATCH";
  title: string;
  message: string;
  blockingServices?: string[];
  location?: SourceLocation;
  nodeSnippet?: string;
  remediation: string;
}

/**
 * Structured refusal report detailing why a flag or codebase cannot be safely purged.
 */
export interface RefusalReport {
  flagKey: string;
  env: string;
  refusalOrigin: RefusalOrigin;
  isBlocked: true;
  reasons: RefusalItem[];
  summary: string;
  generatedAt: string;
}

/**
 * Output format modes for candidate and refusal reports.
 */
export type ReportOutputFormat = "markdown" | "cli" | "json";

/**
 * Formatting options for reports.
 */
export interface ReportFormatOptions {
  includeToolConfigs?: boolean;
  now?: Date | string;
}

/**
 * Aggregated result of running a full purger audit across telemetry and codebase.
 */
export interface PurgerAuditResult {
  candidates: CandidateReport[];
  refusals: RefusalReport[];
  summary: {
    totalEvaluated: number;
    totalQualified: number;
    totalRefused: number;
    totalCallSitesFound: number;
  };
  generatedAt: string;
}

/**
 * Input options for executing a full purger audit.
 */
export interface PurgerAuditOptions {
  snapshots: FlagTelemetrySnapshot[];
  qualificationOptions?: QualificationOptions;
  scanResult?: CodebaseScanResult;
  scannerOptions?: ScannerOptions;
  allowUnreferencedServices?: boolean;
  now?: Date | string;
}
