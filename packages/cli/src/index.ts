#!/usr/bin/env node
import { Command } from "commander";
import { registerKeyCommands } from "./commands/key.js";

export * from "./signer/interface.js";
export * from "./signer/encrypted-file.js";
export * from "./commands/key.js";

const program = new Command();
program
  .name("synapse")
  .description("SRE CLI for SynapseState emergency leases and governance")
  .version("0.1.0");

registerKeyCommands(program);

// Parse arguments if executed as main binary entrypoint
if (process.argv[1] && process.argv[1].endsWith("dist/index.js")) {
  program.parseAsync(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { program };
