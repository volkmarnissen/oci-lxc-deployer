import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@src": path.resolve(__dirname, "src"),
      "@tests": path.resolve(__dirname, "tests"),
    },
  },
  esbuild: {
    sourcemap: "inline",
  },
  test: {
    environment: "node",
    globals: true,
    testTimeout: 60000, // 60 seconds default timeout for all tests
    coverage: {
      reporter: ["text", "html"],
    },
    include: ["tests/**/*.test.mts"],
  },
});
