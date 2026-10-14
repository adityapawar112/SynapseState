import { describe, it, expect } from "vitest";
import { program } from "./index.js";

describe("CLI Program Entrypoint (packages/cli/src/index.ts)", () => {
  it("initializes commander program with name and description", () => {
    expect(program.name()).toBe("synapse");
    expect(program.description()).toBe("SRE CLI for SynapseState emergency leases and governance");
  });

  it("registers key subcommands under program", () => {
    const keyCmd = program.commands.find((c) => c.name() === "key");
    expect(keyCmd).toBeDefined();

    const generateCmd = keyCmd?.commands.find((c) => c.name() === "generate");
    expect(generateCmd).toBeDefined();
    expect(generateCmd?.options.some((opt) => opt.flags.includes("-k, --kid"))).toBe(true);

    const exportCmd = keyCmd?.commands.find((c) => c.name() === "export-public");
    expect(exportCmd).toBeDefined();
    expect(exportCmd?.options.some((opt) => opt.flags.includes("--format"))).toBe(true);
  });

  it("registers lease subcommands under program", () => {
    const leaseCmd = program.commands.find((c) => c.name() === "lease");
    expect(leaseCmd).toBeDefined();

    const subcommands = leaseCmd?.commands.map((c) => c.name());
    expect(subcommands).toContain("create");
    expect(subcommands).toContain("list");
    expect(subcommands).toContain("revoke");
    expect(subcommands).toContain("emergency-apply");

    const createCmd = leaseCmd?.commands.find((c) => c.name() === "create");
    expect(createCmd?.options.some((opt) => opt.flags.includes("-f, --flag"))).toBe(true);
    expect(createCmd?.options.some((opt) => opt.flags.includes("-e, --env"))).toBe(true);
  });
});
