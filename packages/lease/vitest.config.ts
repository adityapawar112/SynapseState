import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    exclude: ["**/.stryker-tmp/**", "node_modules/**", "dist/**"],
  },
});
