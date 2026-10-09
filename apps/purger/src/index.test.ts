import { describe, it, expect } from "vitest";
import { createPurgerProject } from "./index.js";

describe("Purger Scaffolding", () => {
  it("instantiates read-only ts-morph project", () => {
    const project = createPurgerProject();
    expect(project).toBeDefined();
  });
});
