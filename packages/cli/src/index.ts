#!/usr/bin/env node
import { Command } from "commander";
import { registerKeyCommands } from "./commands/key.js";
import { registerLeaseCommands } from "./commands/lease.js";
import { registerLogCommands } from "./commands/log.js";

export * from "./signer/interface.js";
export * from "./signer/encrypted-file.js";
export * from "./commands/key.js";
export * from "./commands/lease.js";
export * from "./commands/log.js";
export * from "./ranker.js";

const program = new Command();
program
  .name("synapse")
  .description("SRE CLI for SynapseState emergency leases and governance")
  .version("0.1.0");

registerKeyCommands(program);
registerLeaseCommands(program);
registerLogCommands(program);

import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Determines whether the current file is the executing CLI binary entrypoint.
 */
export function isMainModule(
  metaUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1 || process.env.SYNAPSE_NO_AUTO_PARSE === "1") return false;
  try {
    const currentPath = fileURLToPath(metaUrl);
    const resolvedArgv = path.resolve(argv1);
    const normalizedArgv = resolvedArgv.replace(/\\/g, "/");
    return (
      currentPath === resolvedArgv ||
      normalizedArgv.endsWith("/packages/cli/dist/index.js") ||
      normalizedArgv.endsWith("/cli/dist/index.js") ||
      resolvedArgv.endsWith("synapse") ||
      resolvedArgv.endsWith("synapse.exe")
    );
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  program.parseAsync(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { program };
