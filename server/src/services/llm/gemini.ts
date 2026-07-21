import { env } from "../../config/env.js";
import { parseSSE } from "../../lib/sse.js";
import { ProviderError, classifyThrown, isRetryableStatus } from "./providerError.js";
import type {
  ChatMessage,
  EmbedOptions,
  EmbedResult,
  EmbeddingProvider,
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  StreamEvent,
  TokenUsage,
} from "./types.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** The Atlas vector index declares this number; a mismatch is rejected at
 *  query time. Configurable, but only meaningfully at index-creation time. */
const EMBED_DIMENSIONS = env.GEMINI_EMBED_DIMENSIONS;

interface GeminiPart {
  text?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string };
}

export class GeminiProvider implements LLMProvider, EmbeddingProvider {
  readonly name = "gemini";
  readonly dimensions = EMBED_DIMENSIONS;

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const response = await this.post(
      `/models/${env.GEMINI_CHAT_MODEL}:generateContent`,
      this.buildBody(options),
      options.signal,
    );

    const data = (await response.json()) as GeminiResponse;

    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");

    // A safety block returns 200 with no candidate text. Treated as
    // non-retryable: the fallback would refuse it too, and silently
    // returning "" would look to the user like the model had nothing to say.
    if (text.length === 0) {
      const reason = data.candidates?.[0]?.finishReason ?? "unknown";
      throw new ProviderError(this.name, `Model returned no content (${reason})`, false);
    }

    return {
      text,
      usage: readUsage(data),
      provider: this.name,
      model: env.GEMINI_CHAT_MODEL,
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    const response = await this.post(
      `/models/${env.GEMINI_CHAT_MODEL}:streamGenerateContent?alt=sse`,
      this.buildBody(options),
      options.signal,
    );

    if (!response.body) {
      throw new ProviderError(this.name, "Streaming response had no body", true);
    }

    // Usage arrives on the final chunk, so we carry the last seen value.
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let emitted = false;

    for await (const raw of parseSSE(response.body)) {
      let chunk: GeminiResponse;
      try {
        chunk = JSON.parse(raw) as GeminiResponse;
      } catch {
        // A single malformed frame should not kill an otherwise good stream.
        continue;
      }

      if (chunk.usageMetadata) usage = readUsage(chunk);

      const text = (chunk.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("");

      if (text.length > 0) {
        emitted = true;
        yield { type: "delta", text };
      }
    }

    if (!emitted) {
      throw new ProviderError(this.name, "Stream produced no content", false);
    }

    yield { type: "done", usage, provider: this.name, model: env.GEMINI_CHAT_MODEL };
  }

  async embed(options: EmbedOptions): Promise<EmbedResult> {
    if (options.texts.length === 0) {
      return { vectors: [], dimensions: EMBED_DIMENSIONS, model: env.GEMINI_EMBED_MODEL };
    }

    const taskType = options.purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";

    const response = await this.post(
      `/models/${env.GEMINI_EMBED_MODEL}:batchEmbedContents`,
      {
        requests: options.texts.map((text) => ({
          model: `models/${env.GEMINI_EMBED_MODEL}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: EMBED_DIMENSIONS,
        })),
      },
      options.signal,
    );

    const data = (await response.json()) as { embeddings?: Array<{ values?: number[] }> };

    // gemini-embedding-001 only returns unit-length vectors at its native
    // 3072 dimensions. Truncating to 768 via outputDimensionality leaves them
    // unnormalised — measured magnitude is around 0.59, not 1.0.
    //
    // This matters because cosine similarity assumes unit vectors. Skipping
    // this step does not error; it just returns subtly wrong rankings, so
    // retrieval quietly gets worse and nothing ever tells you.
    const vectors = (data.embeddings ?? []).map((e) => normalise(e.values ?? []));

    // Silent truncation here would corrupt the index by pairing chunk N's
    // text with chunk N+1's vector — a bug that produces plausible-looking
    // but subtly wrong citations forever after.
    if (vectors.length !== options.texts.length) {
      throw new ProviderError(
        this.name,
        `Expected ${options.texts.length} embeddings, received ${vectors.length}`,
        false,
      );
    }

    return { vectors, dimensions: EMBED_DIMENSIONS, model: env.GEMINI_EMBED_MODEL };
  }

  private buildBody(options: GenerateOptions): Record<string, unknown> {
    return {
      contents: toGeminiContents(options.messages),
      ...(options.system ? { systemInstruction: { parts: [{ text: options.system }] } } : {}),
      generationConfig: {
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxOutputTokens !== undefined
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
        // Reasoning tokens count against maxOutputTokens. Left at the default
        // budget, a low maxOutputTokens can be entirely consumed by thinking,
        // and the model returns an empty answer having "spent" the response.
        thinkingConfig: { thinkingBudget: env.GEMINI_THINKING_BUDGET },
      },
    };
  }

  private async post(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    // The key goes in a header, not the query string. Google's docs show
    // `?key=`, but URLs end up in access logs, proxy caches and error
    // reports — which is exactly how API keys leak.
    const timeout = AbortSignal.timeout(env.LLM_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      throw classifyThrown(this.name, err);
    }

    if (!response.ok) {
      const detail = await readErrorMessage(response);
      throw new ProviderError(
        this.name,
        `Gemini returned ${response.status}: ${detail}`,
        isRetryableStatus(response.status),
        response.status,
      );
    }

    return response;
  }
}

/**
 * Gemini names the assistant role "model", and has no notion of a system
 * message inside `contents` — it goes in `systemInstruction` instead.
 * Consecutive same-role turns are also rejected, so they are merged.
 */
function toGeminiContents(
  messages: ChatMessage[],
): Array<{ role: string; parts: GeminiPart[] }> {
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const previous = contents.at(-1);

    if (previous && previous.role === role) {
      previous.parts.push({ text: message.content });
    } else {
      contents.push({ role, parts: [{ text: message.content }] });
    }
  }

  return contents;
}

/** Scales a vector to unit length so cosine similarity behaves as intended. */
function normalise(values: number[]): number[] {
  let sumOfSquares = 0;
  for (const value of values) sumOfSquares += value * value;

  const magnitude = Math.sqrt(sumOfSquares);
  // A zero vector cannot be normalised; returning it unchanged is safer than
  // dividing by zero and filling the index with NaN.
  if (magnitude === 0) return values;

  return values.map((value) => value / magnitude);
}

function readUsage(data: GeminiResponse): TokenUsage {
  return {
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

export const geminiProvider = new GeminiProvider();
