import { defineConfig } from "vitest/config";

// Tests that start real programs (the fake Claude, Docker, shells) are slow when the whole suite runs in parallel.
export default defineConfig({ test: { testTimeout: 20_000, hookTimeout: 20_000 } });
