import type { ChatMessage } from "../llm/types.js";
import { estimateMessageTokens, estimateTokens } from "./tokens.js";

export interface BuildContextInput {
  /** Newest last. */
  history: ChatMessage[];
  /** Running summary of everything already evicted from the window. */
  summary?: string | undefined;
  systemPrompt: string;
  /** Total input tokens the model may receive. */
  budget: number;
}

export interface BuiltContext {
  /** Ready to send. */
  messages: ChatMessage[];
  system: string;
  /** Messages that did not fit and now need folding into the summary. */
  evicted: ChatMessage[];
  estimatedTokens: number;
}

/**
 * Chooses which slice of a conversation to send.
 *
 * The naive options are both wrong. Sending only the latest message — what
 * the original code did — means the model has no memory at all. Sending
 * everything grows without bound: cost rises on every turn, latency with it,
 * and eventually the provider rejects the request outright, at which point
 * the conversation is permanently broken rather than merely expensive.
 *
 * So we keep a token budget. Recent turns are preserved verbatim because
 * that is what the user is actually referring to; older ones are evicted and
 * folded into a running summary, so the thread keeps its gist without
 * carrying its full weight.
 *
 * Walking backwards from the newest message is what makes this correct: it
 * guarantees the most relevant turns survive when the budget is tight.
 */
export function buildContext(input: BuildContextInput): BuiltContext {
  const system = input.summary
    ? `${input.systemPrompt}\n\nSummary of earlier conversation:\n${input.summary}`
    : input.systemPrompt;

  // The system prompt is not optional, so it is charged against the budget
  // before anything else competes for the space.
  const systemTokens = estimateTokens(system);
  let remaining = input.budget - systemTokens;

  const kept: ChatMessage[] = [];
  let keptTokens = 0;
  let cutoff = 0;

  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    const message = input.history[i];
    if (!message) continue;

    const cost = estimateMessageTokens(message);

    if (cost > remaining) {
      cutoff = i + 1;
      break;
    }

    kept.push(message);
    keptTokens += cost;
    remaining -= cost;
  }

  kept.reverse();

  // The newest message alone can exceed the budget — someone pastes an essay.
  // Dropping it would answer a question the user did not ask, so it is kept
  // and the provider's own limit becomes the backstop. Truncating the user's
  // input is a product decision, not something to do silently here.
  if (kept.length === 0 && input.history.length > 0) {
    const newest = input.history[input.history.length - 1];
    if (newest) {
      kept.push(newest);
      keptTokens += estimateMessageTokens(newest);
      cutoff = input.history.length - 1;
    }
  }

  return {
    messages: kept,
    system,
    evicted: input.history.slice(0, cutoff),
    estimatedTokens: systemTokens + keptTokens,
  };
}
