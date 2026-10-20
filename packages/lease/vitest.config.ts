import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    exclude: ["**/.stryker-tmp/**", "**/reports/**", "node_modules/**", "dist/**"],
  },
});
