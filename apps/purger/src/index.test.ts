import { describe, it, expect } from "vitest";
import {
  createPurgerProject,
  evaluateCandidateQuiescence,
  qualifyFlagTelemetryBatch,
  buildQuiescenceRollupQuery,
  mapRowToFlagTelemetrySnapshot,
  fetchFlagTelemetrySnapshots,
  scanSourceFiles,
  scanSourceTexts,
  scanCodebase,
  crossReferenceConsumers,
  defaultServiceResolver,
  normalizeFilePath,
  unwrapExpression,
  OPENFEATURE_EVAL_METHODS,
} from "./index.js";

describe("Purger Package Exports", () => {
  it("instantiates read-only ts-morph project", () => {
    const project = createPurgerProject();
    expect(project).toBeDefined();
  });

  it("exports qualification domain engine and SQL query utilities", () => {
    expect(evaluateCandidateQuiescence).toBeTypeOf("function");
    expect(qualifyFlagTelemetryBatch).toBeTypeOf("function");
    expect(buildQuiescenceRollupQuery).toBeTypeOf("function");
    expect(mapRowToFlagTelemetrySnapshot).toBeTypeOf("function");
    expect(fetchFlagTelemetrySnapshots).toBeTypeOf("function");
  });

  it("exports scanner domain utilities, functions, and method constants", () => {
    expect(scanSourceFiles).toBeTypeOf("function");
    expect(scanSourceTexts).toBeTypeOf("function");
    expect(scanCodebase).toBeTypeOf("function");
    expect(crossReferenceConsumers).toBeTypeOf("function");
    expect(defaultServiceResolver).toBeTypeOf("function");
    expect(normalizeFilePath).toBeTypeOf("function");
    expect(unwrapExpression).toBeTypeOf("function");
    expect(Array.isArray(OPENFEATURE_EVAL_METHODS)).toBe(true);
    expect(OPENFEATURE_EVAL_METHODS).toContain("getBooleanValue");
  });

  it("exports candidate and refusal report generators and audit pipeline", async () => {
    const purger = await import("./index.js");
    expect(purger.createCandidateReport).toBeTypeOf("function");
    expect(purger.formatCandidateReportMarkdown).toBeTypeOf("function");
    expect(purger.formatCandidateReportCli).toBeTypeOf("function");
    expect(purger.formatCandidateReportJson).toBeTypeOf("function");
    expect(purger.createRefusalReportFromQualification).toBeTypeOf("function");
    expect(purger.createRefusalReportFromCrossReference).toBeTypeOf("function");
    expect(purger.formatRefusalReportMarkdown).toBeTypeOf("function");
    expect(purger.formatRefusalReportCli).toBeTypeOf("function");
    expect(purger.formatRefusalReportJson).toBeTypeOf("function");
    expect(purger.runPurgerAudit).toBeTypeOf("function");
    expect(purger.formatPurgerAuditMarkdown).toBeTypeOf("function");
    expect(purger.formatPurgerAuditCli).toBeTypeOf("function");
    expect(purger.formatPurgerAuditJson).toBeTypeOf("function");
  });
});
