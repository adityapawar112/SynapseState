import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findMonorepoRoot(startDir: string): string {
  let curr = startDir;
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return startDir;
}

const root = findMonorepoRoot(__dirname);
const leaseSrc = path.resolve(root, "packages/lease/src/index.ts");
const leaseDist = path.resolve(root, "packages/lease/dist/index.js");
const leaseEntry = fs.existsSync(leaseSrc) ? leaseSrc : leaseDist;

export default defineConfig({
  test: {
    fileParallelism: false,
    exclude: ["**/.stryker-tmp/**", "**/reports/**", "node_modules/**", "dist/**"],
  },
  resolve: {
    alias: {
      "@synapsestate/lease": leaseEntry,
    },
  },
});
