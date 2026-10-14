import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // the integration test drives one shared anvil instance; never run files in parallel
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
