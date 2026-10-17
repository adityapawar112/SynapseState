import { describe, it, expect } from "vitest";
import {
  createPurgerProject,
  evaluateCandidateQuiescence,
  qualifyFlagTelemetryBatch,
  buildQuiescenceRollupQuery,
  mapRowToFlagTelemetrySnapshot,
  fetchFlagTelemetrySnapshots,
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
});
