import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/firestore/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    passWithNoTests: true,
    // 実際の Firestore への往復があるので、既定より長くする。
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
