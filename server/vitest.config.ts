import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],

    /**
     * Integration tests share one in-memory MongoDB, so they must not run in
     * parallel against it — two files creating a user with the same email
     * would collide on the unique index and fail for reasons that have
     * nothing to do with the code under test.
     *
     * Unit tests are unaffected; this costs a second or two overall.
     */
    fileParallelism: false,

    // Starting an in-memory replica set is slow the first time (it downloads
    // a MongoDB binary), so the default 5s is not enough.
    testTimeout: 30_000,
    hookTimeout: 120_000,

    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/server.ts",
        "src/scripts/**",
        "src/types/**",
        // Provider adapters are thin wrappers over a network API. Testing
        // them means testing a mock of someone else's HTTP contract, which
        // proves nothing — the FakeProvider is what the rest of the suite
        // uses, and the real ones are exercised by the eval harness.
        "src/services/llm/gemini.ts",
        "src/services/llm/groq.ts",
      ],
    },
  },
});
