/**
 * The contract every language model provider implements.
 *
 * Nothing above this file knows that Gemini or Groq exist. That is the whole
 * point: the original code baked OpenAI's URL, auth header and response shape
 * into the request handler, so changing provider meant editing business logic,
 * and testing meant either hitting a paid API or mocking `fetch` globally.
 *
 * With an interface here we get three things for free: failover between
 * providers, a fake implementation for tests that runs offline in
 * milliseconds, and the ability to swap models without touching a route.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateOptions {
  messages: ChatMessage[];
  /** Hoisted out of `messages` because providers deliver it differently. */
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Cancels the upstream HTTP request. Wired to client disconnect so that
   * closing a tab actually stops the generation instead of burning tokens
   * on a response nobody will ever read.
   */
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  usage: TokenUsage;
  /** Which provider and model actually served this — the request may have
   *  failed over, and the caller needs to know for logging and cost accounting. */
  provider: string;
  model: string;
}

/** Incremental output. A stream is zero or more `delta`s then exactly one `done`. */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage: TokenUsage; provider: string; model: string };

export interface EmbedOptions {
  texts: string[];
  /**
   * Embeddings are asymmetric: the vector for a stored passage should be
   * computed differently from the vector for a search query, even for
   * identical text. Getting this wrong quietly degrades retrieval quality
   * in a way no test will catch.
   */
  purpose: "document" | "query";
  signal?: AbortSignal;
}

export interface EmbedResult {
  /** One vector per input, in the same order. */
  vectors: number[][];
  dimensions: number;
  model: string;
}

export interface LLMProvider {
  readonly name: string;
  generate(options: GenerateOptions): Promise<GenerateResult>;
  stream(options: GenerateOptions): AsyncIterable<StreamEvent>;
}

/** Not every provider offers embeddings on a free tier, so this is separate. */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(options: EmbedOptions): Promise<EmbedResult>;
}
