import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "eval/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "tests/firestore/**"],
    passWithNoTests: true,
  },
});
