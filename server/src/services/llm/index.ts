import { isTest } from "../../config/env.js";
import { FallbackProvider } from "./fallbackProvider.js";
import { FakeProvider } from "./fakeProvider.js";
import { geminiProvider } from "./gemini.js";
import { groqProvider } from "./groq.js";
import type { EmbeddingProvider, LLMProvider } from "./types.js";

/**
 * Under test, everything resolves to an in-memory fake.
 *
 * This is the practical payoff of the interface. The suite runs offline, in
 * milliseconds, deterministically, and without spending a cent — and it does
 * so by substituting an implementation rather than by intercepting `fetch`,
 * which would test the mock instead of the code. The real adapters are
 * exercised by the eval harness, against the real APIs, where that is the
 * actual subject.
 *
 * Exported so tests can assert on what the application actually sent.
 */
export const testProvider = isTest
  ? new FakeProvider({
      name: "test",
      replies: ["This is a test reply from the fake provider."],
    })
  : null;

/**
 * The single place where concrete providers are chosen and ordered.
 * Everything else in the application depends on the interfaces, not on these.
 *
 * Order is deliberate: Gemini first because it also supplies embeddings, so
 * keeping it as the primary means chat and retrieval share a vendor and a
 * quota we can reason about. Groq exists to absorb Gemini's rate limits.
 */
export const chatProvider: LLMProvider =
  testProvider ?? new FallbackProvider([geminiProvider, groqProvider]);

/**
 * Embeddings deliberately do NOT fail over. Vectors from two different models
 * are not comparable — mixing them in one index does not throw, it just
 * quietly returns nonsense for the affected documents. Better to fail the
 * upload and retry than to poison the index.
 */
export const embeddingProvider: EmbeddingProvider = testProvider ?? geminiProvider;

export * from "./types.js";
export { ProviderError } from "./providerError.js";
export { FallbackProvider } from "./fallbackProvider.js";
export { FakeProvider } from "./fakeProvider.js";
