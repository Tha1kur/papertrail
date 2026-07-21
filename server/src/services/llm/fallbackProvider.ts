import { logger } from "../../lib/logger.js";
import { ProviderError, classifyThrown } from "./providerError.js";
import type { GenerateOptions, GenerateResult, LLMProvider, StreamEvent } from "./types.js";

/**
 * Tries providers in order, moving to the next one only on failures that
 * another provider could plausibly survive.
 *
 * This is the payoff for having an interface at all: the free tiers we are
 * running on rate-limit aggressively and without warning, and a single 429
 * would otherwise be a user-visible failure. With two providers behind one
 * interface it becomes a logged blip.
 */
export class FallbackProvider implements LLMProvider {
  readonly name = "fallback";

  constructor(private readonly providers: readonly LLMProvider[]) {
    if (providers.length === 0) {
      throw new Error("FallbackProvider requires at least one provider");
    }
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    let lastError: ProviderError | undefined;

    for (const [index, provider] of this.providers.entries()) {
      // If the caller has already given up, stop — do not keep trying
      // providers on behalf of a request nobody is waiting for.
      if (options.signal?.aborted) break;

      try {
        const result = await provider.generate(options);

        if (index > 0) {
          logger.warn(
            { provider: provider.name, afterFailure: lastError?.provider },
            "served by fallback provider",
          );
        }
        return result;
      } catch (err) {
        const error = classifyThrown(provider.name, err);
        lastError = error;

        if (!error.retryable) throw error;

        const isLast = index === this.providers.length - 1;
        logger.warn(
          { provider: provider.name, status: error.status, err: error.message, isLast },
          isLast ? "all providers failed" : "provider failed, falling over",
        );
      }
    }

    throw lastError ?? new ProviderError(this.name, "No provider produced a response", true);
  }

  /**
   * Streaming failover has a constraint that non-streaming does not: once a
   * single token has been handed to the caller, we are committed.
   *
   * Switching providers mid-stream would splice two different completions
   * together — the user would see the first half of one answer followed by
   * the beginning of another. So failover is only permitted *before* the
   * first delta is emitted. After that, a failure propagates and the caller
   * deals with a truncated response.
   *
   * This is why the streaming route persists its message as `incomplete`
   * rather than assuming success.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    let lastError: ProviderError | undefined;

    for (const [index, provider] of this.providers.entries()) {
      if (options.signal?.aborted) break;

      let committed = false;

      try {
        for await (const event of provider.stream(options)) {
          if (event.type === "delta") committed = true;
          yield event;
        }

        if (index > 0) {
          logger.warn({ provider: provider.name }, "stream served by fallback provider");
        }
        return;
      } catch (err) {
        const error = classifyThrown(provider.name, err);
        lastError = error;

        if (committed) {
          logger.error(
            { provider: provider.name, err: error.message },
            "stream failed after partial output — cannot fail over",
          );
          throw error;
        }

        if (!error.retryable) throw error;

        logger.warn(
          { provider: provider.name, status: error.status, err: error.message },
          "stream failed before first token, falling over",
        );
      }
    }

    throw lastError ?? new ProviderError(this.name, "No provider produced a stream", true);
  }
}
