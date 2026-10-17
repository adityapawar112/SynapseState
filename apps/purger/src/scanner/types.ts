/**
 * Domain Models for SynapseState Purger Read-Only ts-morph AST Scanner.
 *
 * Implements authoritative domain vocabulary and data contracts as defined in:
 * - AGENTS.md (§1 Non-Goals, §2 Architectural Invariants 1-8)
 * - docs/ARCHITECTURE.md (§9 Telemetry-Driven Stale Detection & Scanner, §10 Security Threat Model)
 * - GLOSSARY.md
 */

import type { Project } from "ts-morph";
import type { CandidateFlag } from "../qualification/types.js";

/**
 * Standard OpenFeature evaluation method names targeted by the read-only AST scanner.
 */
export const OPENFEATURE_EVAL_METHODS = [
  "getBooleanValue",
  "getBooleanDetails",
  "getStringValue",
  "getStringDetails",
  "getNumberValue",
  "getNumberDetails",
  "getObjectValue",
  "getObjectDetails",
] as const;

export type OpenFeatureEvalMethod = (typeof OPENFEATURE_EVAL_METHODS)[number];

/**
 * Categorical reasons why an AST call site cannot be safely qualified or processed.
 */
export type ScannerRefusalReason =
  | "NON_LITERAL_FLAG_KEY"
  | "MISSING_ARGUMENTS"
  | "MISSING_DEFAULT_VALUE"
  | "UNDECLARED_CONSUMER_SERVICE";

/**
 * Exact source code coordinates for a detected call site or refusal (1-indexed).
 */
export interface SourceLocation {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * Structural scope context enclosing an OpenFeature evaluation call site.
 */
export interface EnclosingScope {
  functionName?: string;
  className?: string;
  kind: string;
}

/**
 * Structured refusal marker emitted when an evaluation expression violates safety invariants.
 */
export interface RefusalMarker {
  reason: ScannerRefusalReason;
  message: string;
  nodeText: string;
  location: SourceLocation;
}

/**
 * A specific syntactic location in application source code where an OpenFeature
 * client evaluates a feature flag.
 */
export interface CallSite {
  flagKey: string | null;
  isLiteralKey: boolean;
  methodName: string;
  defaultValueText?: string;
  location: SourceLocation;
  scope: EnclosingScope;
  fullCallText: string;
  serviceName?: string;
  refusal?: RefusalMarker;
}

/**
 * Codebase-wide index of all discovered AST call sites for a single flag key.
 */
export interface ASTFlagReference {
  flagKey: string;
  totalCallSites: number;
  callSites: CallSite[];
  consumerServices: string[];
  hasRefusals: boolean;
  refusals: RefusalMarker[];
}

/**
 * Cross-referencing comparison between runtime evaluated services (telemetry)
 * and static AST call sites (source code).
 */
export interface ConsumerCrossReference {
  flagKey: string;
  isConsistent: boolean;
  evaluatingServices: string[];
  astConsumerServices: string[];
  undeclaredServices: string[];
  unreferencedServices: string[];
  callSites: CallSite[];
  refusals: RefusalMarker[];
}

/**
 * Aggregated result of scanning a project or collection of source files.
 */
export interface CodebaseScanResult {
  totalFilesScanned: number;
  totalCallSites: number;
  callSites: CallSite[];
  flagReferences: Record<string, ASTFlagReference>;
  unresolvedCallSites: CallSite[];
  refusals: RefusalMarker[];
}

/**
 * Options configuring the AST codebase scanner.
 */
export interface ScannerOptions {
  project?: Project;
  sourceFilePaths?: string[];
  sourceTexts?: Array<{ filePath: string; content: string }>;
  serviceResolver?: (filePath: string) => string | undefined;
  rootPath?: string;
}

/**
 * Options for cross-referencing candidate flags against scanned AST references.
 */
export interface CrossReferenceOptions {
  candidates: CandidateFlag[];
  scanResult: CodebaseScanResult;
}
