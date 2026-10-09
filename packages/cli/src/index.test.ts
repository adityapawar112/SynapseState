import { describe, it, expect } from "vitest";
import { program } from "./index.js";

describe("CLI Package Scaffolding", () => {
  it("initializes commander program", () => {
    expect(program.name()).toBe("synapse");
  });
});
