import type { ChatMessage } from "../llm/types.js";

/**
 * Token estimation, deliberately approximate.
 *
 * The exact count depends on the model's tokeniser, and we target two
 * different families — Gemini and Llama — whose tokenisers disagree on the
 * same string. Gemini exposes a countTokens endpoint, but calling it before
 * every request adds a network round trip to the critical path purely to
 * decide what to send, and it would need calling again after any change.
 *
 * So: estimate locally, and keep enough headroom that being wrong is
 * harmless. The failure we are protecting against is exceeding the context
 * window, which the provider rejects outright — so the estimate is
 * intentionally biased to overcount. Sending slightly less history than we
 * could is invisible; sending too much is a hard error.
 */

/**
 * Roughly four characters per token for English prose. Code, JSON and
 * non-Latin scripts are denser, hence the ceiling rather than a round.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Every message carries structural overhead beyond its text — role markers
 * and separators the provider adds when serialising the conversation. Left
 * unaccounted for, a long thread of short messages underestimates badly:
 * a hundred "yes" replies is far more than a hundred tokens on the wire.
 */
const PER_MESSAGE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: ChatMessage): number {
  return estimateTokens(message.content) + PER_MESSAGE_OVERHEAD;
}

export function estimateConversationTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}
