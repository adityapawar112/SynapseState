import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    fileParallelism: false,
    coverage: {
      provider: "v8",
    },
  },
  resolve: {
    alias: {
      "@synapsestate/lease": path.resolve(
        __dirname,
        "./packages/lease/src/index.ts",
      ),
      "@synapsestate/sdk": path.resolve(
        __dirname,
        "./packages/sdk/src/index.ts",
      ),
    },
  },
});
