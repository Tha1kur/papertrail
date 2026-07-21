import type { ChatMessage, LLMProvider } from "../llm/types.js";
import { logger } from "../../lib/logger.js";

const SUMMARY_PROMPT = `You are compressing the earlier part of a conversation so it can be carried forward in limited space.

Write a factual summary that preserves:
- what the user is trying to achieve
- decisions, preferences and constraints they have stated
- specific names, numbers, files and identifiers mentioned
- anything the user asked to be remembered

Omit pleasantries and anything already superseded. Write in the third person, under 200 words, as continuous prose with no preamble.`;

export interface SummariseInput {
  previousSummary?: string | undefined;
  evicted: ChatMessage[];
  provider: LLMProvider;
  signal?: AbortSignal | undefined;
}

/**
 * Folds newly evicted turns into the running summary.
 *
 * Summarising the summary each round is lossy by nature — detail degrades
 * with every pass, which is why the prompt names the categories worth
 * protecting rather than asking for a generic précis.
 *
 * Returns null on failure rather than throwing. A failed summary should
 * degrade the conversation's memory, not the user's ability to send a
 * message: the reply still goes out, just with less recall of the distant
 * past. Failing the whole request here would be trading something the user
 * needs for something they merely benefit from.
 */
export async function summarise(input: SummariseInput): Promise<string | null> {
  if (input.evicted.length === 0) return input.previousSummary ?? null;

  const transcript = input.evicted
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");

  const instruction = input.previousSummary
    ? `Existing summary:\n${input.previousSummary}\n\nNewly evicted turns:\n${transcript}\n\nProduce a single merged summary.`
    : `Conversation so far:\n${transcript}`;

  try {
    const result = await input.provider.generate({
      system: SUMMARY_PROMPT,
      messages: [{ role: "user", content: instruction }],
      // Low temperature: this is compression, not composition. Creativity
      // here means inventing details that were never said.
      temperature: 0.2,
      maxOutputTokens: 400,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    return result.text.trim();
  } catch (err) {
    logger.warn({ err }, "summarisation failed — continuing without updated summary");
    return input.previousSummary ?? null;
  }
}
