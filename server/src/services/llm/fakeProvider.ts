import { ProviderError } from "./providerError.js";
import type {
  EmbedOptions,
  EmbedResult,
  EmbeddingProvider,
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  StreamEvent,
} from "./types.js";

interface FakeConfig {
  /** Replies handed out in order; the last one repeats once exhausted. */
  replies?: string[];
  /** Throw instead of replying — used to exercise the failover paths. */
  failWith?: ProviderError;
  /** Emit this many deltas before throwing, to test mid-stream failure. */
  failAfterDeltas?: number;
  name?: string;
}

/**
 * In-memory provider for tests.
 *
 * The reason the interface exists in this shape: the entire test suite can
 * run offline, deterministically, in milliseconds, without a network call or
 * a cent of quota. Testing the old code meant either hitting the real API or
 * monkey-patching global fetch — the first is slow, flaky and costs money,
 * the second tests the mock rather than the code.
 */
export class FakeProvider implements LLMProvider, EmbeddingProvider {
  readonly name: string;
  readonly dimensions = 768;

  /** Every call made, so tests can assert on what the app actually sent. */
  readonly calls: GenerateOptions[] = [];

  private cursor = 0;

  constructor(private readonly config: FakeConfig = {}) {
    this.name = config.name ?? "fake";
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    this.calls.push(options);
    if (this.config.failWith) throw this.config.failWith;

    const text = this.nextReply();
    return {
      text,
      usage: { inputTokens: countWords(options.messages.map((m) => m.content).join(" ")), outputTokens: countWords(text) },
      provider: this.name,
      model: "fake-model",
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    this.calls.push(options);

    if (this.config.failWith && this.config.failAfterDeltas === undefined) {
      throw this.config.failWith;
    }

    const text = this.nextReply();
    const words = text.split(" ");
    let emitted = 0;

    for (const [index, word] of words.entries()) {
      if (options.signal?.aborted) return;

      if (this.config.failWith && emitted === this.config.failAfterDeltas) {
        throw this.config.failWith;
      }

      yield { type: "delta", text: index === 0 ? word : ` ${word}` };
      emitted += 1;
    }

    yield {
      type: "done",
      usage: { inputTokens: 0, outputTokens: words.length },
      provider: this.name,
      model: "fake-model",
    };
  }

  /**
   * Deterministic pseudo-embeddings derived from the text itself, normalised
   * to unit length. Identical text always yields an identical vector and
   * different text yields a different one, which is all a retrieval test
   * needs — without calling a real embedding API.
   */
  async embed(options: EmbedOptions): Promise<EmbedResult> {
    const vectors = options.texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      for (let i = 0; i < text.length; i += 1) {
        const index = (text.charCodeAt(i) * (i + 1)) % this.dimensions;
        vector[index] = (vector[index] ?? 0) + 1;
      }
      const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
      return vector.map((v) => v / magnitude);
    });

    return { vectors, dimensions: this.dimensions, model: "fake-embed" };
  }

  private nextReply(): string {
    const replies = this.config.replies ?? ["This is a fake reply."];
    const reply = replies[Math.min(this.cursor, replies.length - 1)] ?? "";
    this.cursor += 1;
    return reply;
  }
}

function countWords(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}
