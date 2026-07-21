import { FallbackProvider } from "./fallbackProvider.js";
import { geminiProvider } from "./gemini.js";
import { groqProvider } from "./groq.js";
import type { EmbeddingProvider, LLMProvider } from "./types.js";

/**
 * The single place where concrete providers are chosen and ordered.
 * Everything else in the application depends on the interfaces, not on these.
 *
 * Order is deliberate: Gemini first because it also supplies embeddings, so
 * keeping it as the primary means chat and retrieval share a vendor and a
 * quota we can reason about. Groq exists to absorb Gemini's rate limits.
 */
export const chatProvider: LLMProvider = new FallbackProvider([geminiProvider, groqProvider]);

/**
 * Embeddings deliberately do NOT fail over. Vectors from two different models
 * are not comparable — mixing them in one index does not throw, it just
 * quietly returns nonsense for the affected documents. Better to fail the
 * upload and retry than to poison the index.
 */
export const embeddingProvider: EmbeddingProvider = geminiProvider;

export * from "./types.js";
export { ProviderError } from "./providerError.js";
export { FallbackProvider } from "./fallbackProvider.js";
export { FakeProvider } from "./fakeProvider.js";
