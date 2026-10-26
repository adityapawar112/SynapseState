import { Project } from "ts-morph";

export function createPurgerProject(): Project {
  return new Project({
    skipAddingFilesFromTsConfig: true,
  });
}

// Explicit re-exports for qualification domain types, engine, and SQL queries
export type {
  FlagLifecycleClass,
  ServiceStatus,
  QualificationStatus,
  DisqualificationReason,
  CandidateFlag,
  QualificationResult,
  VariantEvaluation,
  ConsumerServiceEvaluation,
  FlagTelemetrySnapshot,
  QualificationOptions,
  Queryable,
  RollupQueryOptions,
  RawRollupRow,
} from "./qualification/types.js";

export {
  DEFAULT_MIN_WINDOW_DAYS,
  evaluateCandidateQuiescence,
  qualifyFlagTelemetryBatch,
} from "./qualification/engine.js";

export {
  buildQuiescenceRollupQuery,
  mapRowToFlagTelemetrySnapshot,
  fetchFlagTelemetrySnapshots,
} from "./qualification/queries.js";

// Explicit re-exports for read-only AST scanner domain types and utilities
export type {
  OpenFeatureEvalMethod,
  ScannerRefusalReason,
  SourceLocation,
  EnclosingScope,
  RefusalMarker,
  CallSite,
  ASTFlagReference,
  ConsumerCrossReference,
  CodebaseScanResult,
  ScannerOptions,
  CrossReferenceOptions,
} from "./scanner/types.js";

export { OPENFEATURE_EVAL_METHODS } from "./scanner/types.js";

export {
  defaultServiceResolver,
  normalizeFilePath,
  unwrapExpression,
  scanSourceFiles,
  scanSourceTexts,
  scanCodebase,
  crossReferenceConsumers,
} from "./scanner/scanner.js";

// Explicit re-exports for candidate & refusal report domain types and utilities
export type {
  VariantDataType,
  CallSiteReportRow,
  PiranhaConfig,
  GritQLPattern,
  CandidateReport,
  RefusalOrigin,
  RefusalItem,
  RefusalReport,
  ReportOutputFormat,
  ReportFormatOptions,
  PurgerAuditResult,
  PurgerAuditOptions,
} from "./reports/types.js";

export {
  CLI_SEPARATOR,
  getDefaultMethodsForVariantType,
  inferVariantType,
  formatScopeDescription,
  formatCallSiteReportRow,
  buildPiranhaConfig,
  buildGritQLPattern,
  createCandidateReport,
  formatCandidateReportMarkdown,
  formatCandidateReportCli,
  formatCandidateReportJson,
  mapDisqualificationReasonToItem,
  createRefusalReportFromQualification,
  mapRefusalMarkerToItem,
  createRefusalReportFromCrossReference,
  formatRefusalReportMarkdown,
  formatRefusalReportCli,
  formatRefusalReportJson,
  runPurgerAudit,
  formatPurgerAuditMarkdown,
  formatPurgerAuditCli,
  formatPurgerAuditJson,
} from "./reports/index.js";
