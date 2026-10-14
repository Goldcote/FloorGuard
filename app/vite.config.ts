import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset URLs: the build works from any path of its origin (routing is by hash).
  base: "./",
  plugins: [react()],
  // One file at a time: two of them share one local anvil chain (snapshots, time travel).
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, fileParallelism: false },
});
