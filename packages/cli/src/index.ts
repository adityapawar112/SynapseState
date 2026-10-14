#!/usr/bin/env node
import { Command } from "commander";
import { registerKeyCommands } from "./commands/key.js";
import { registerLeaseCommands } from "./commands/lease.js";

export * from "./signer/interface.js";
export * from "./signer/encrypted-file.js";
export * from "./commands/key.js";
export * from "./commands/lease.js";

const program = new Command();
program
  .name("synapse")
  .description("SRE CLI for SynapseState emergency leases and governance")
  .version("0.1.0");

registerKeyCommands(program);
registerLeaseCommands(program);

import path from "node:path";
import { fileURLToPath } from "node:url";

// Parse arguments if executed as main binary entrypoint
const isMainModule =
  Boolean(process.argv[1]) &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    process.argv[1].replace(/\\/g, "/").endsWith("dist/index.js") ||
    process.argv[1].endsWith("synapse"));

if (isMainModule) {
  program.parseAsync(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { program };
