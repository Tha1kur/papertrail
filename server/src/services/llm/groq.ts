import { env } from "../../config/env.js";
import { parseSSE } from "../../lib/sse.js";
import { ProviderError, classifyThrown, isRetryableStatus } from "./providerError.js";
import type {
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  StreamEvent,
  TokenUsage,
} from "./types.js";

const BASE_URL = "https://api.groq.com/openai/v1";

interface CompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    delta?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/**
 * Failover provider for chat. Groq speaks the OpenAI wire format, so this is
 * a thin adapter — but note it implements only `LLMProvider`, not
 * `EmbeddingProvider`. Groq has no free embeddings endpoint, which is why
 * Gemini is primary rather than the other way round: retrieval must keep
 * using one consistent embedding model or stored vectors become
 * incomparable with query vectors.
 */
export class GroqProvider implements LLMProvider {
  readonly name = "groq";

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const response = await this.post(this.buildBody(options, false), options.signal);
    const data = (await response.json()) as CompletionResponse;

    const text = data.choices?.[0]?.message?.content ?? "";
    if (text.length === 0) {
      throw new ProviderError(this.name, "Model returned no content", false);
    }

    return {
      text,
      usage: readUsage(data),
      provider: this.name,
      model: env.GROQ_CHAT_MODEL,
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    const response = await this.post(this.buildBody(options, true), options.signal);

    if (!response.body) {
      throw new ProviderError(this.name, "Streaming response had no body", true);
    }

    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let emitted = false;

    for await (const raw of parseSSE(response.body)) {
      // OpenAI-compatible streams terminate with a literal sentinel rather
      // than simply closing.
      if (raw === "[DONE]") break;

      let chunk: CompletionResponse;
      try {
        chunk = JSON.parse(raw) as CompletionResponse;
      } catch {
        continue;
      }

      if (chunk.usage) usage = readUsage(chunk);

      const text = chunk.choices?.[0]?.delta?.content;
      if (typeof text === "string" && text.length > 0) {
        emitted = true;
        yield { type: "delta", text };
      }
    }

    if (!emitted) {
      throw new ProviderError(this.name, "Stream produced no content", false);
    }

    yield { type: "done", usage, provider: this.name, model: env.GROQ_CHAT_MODEL };
  }

  private buildBody(options: GenerateOptions, stream: boolean): Record<string, unknown> {
    // Unlike Gemini, the system prompt is just another message, at the front.
    const messages = options.system
      ? [{ role: "system", content: options.system }, ...options.messages]
      : options.messages;

    return {
      model: env.GROQ_CHAT_MODEL,
      messages,
      stream,
      // Without this, a streamed response reports no token counts at all,
      // and per-user cost accounting silently records zero.
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxOutputTokens !== undefined
        ? { max_completion_tokens: options.maxOutputTokens }
        : {}),
    };
  }

  private async post(body: unknown, signal: AbortSignal | undefined): Promise<Response> {
    const timeout = AbortSignal.timeout(env.LLM_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
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
        `Groq returned ${response.status}: ${detail}`,
        isRetryableStatus(response.status),
        response.status,
      );
    }

    return response;
  }
}

function readUsage(data: CompletionResponse): TokenUsage {
  return {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
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

export const groqProvider = new GroqProvider();
