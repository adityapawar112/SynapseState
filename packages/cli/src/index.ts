#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();
program
  .name("synapse")
  .description("SRE CLI for SynapseState emergency leases and governance")
  .version("0.1.0");

export { program };
