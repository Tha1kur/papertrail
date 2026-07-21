import { chatProvider } from "./llm/index.js";
import type { ChatMessage, LLMProvider, StreamEvent } from "./llm/types.js";
import { buildContext } from "./context/contextWindow.js";
import { summarise } from "./context/summariser.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  appendMessage,
  beginStreamingMessage,
  finaliseMessage,
  recentMessages,
  type MessageView,
} from "../repositories/messageRepository.js";
import {
  ensureThread,
  getSummaryState,
  updateSummary,
} from "../repositories/threadRepository.js";

/**
 * Written for a general conversation, with document grounding layered on
 * only when documents are actually retrieved.
 *
 * The first version of this told the model it answered questions "about the
 * user's documents" and to refuse anything not found in them. With no
 * retrieval wired up yet, that made it refuse everything — it answered "I am
 * unable to remember your favourite colour" to a message that had just told
 * it. A prompt describing a capability the system does not yet have does not
 * degrade gracefully; it actively breaks the parts that do work.
 */
const SYSTEM_PROMPT = `You are PaperTrail, a helpful assistant.

Be direct and concrete. Prefer specifics over hedging. If you do not know
something, say so rather than guessing.

You remember what the user has told you earlier in this conversation and
should use it.

When passages from the user's documents are supplied, ground your answer in
them and cite which one you used. Say plainly when they do not cover the
question, rather than quietly filling the gap from general knowledge.`;

/**
 * Upper bound on how many stored messages we will even consider for the
 * context window. The budget usually bites first; this stops a thread with
 * ten thousand messages from loading all of them just to throw most away.
 */
const MAX_HISTORY_FETCH = 200;

export interface SendInput {
  threadId: string;
  message: string;
  clientMessageId?: string | undefined;
  signal?: AbortSignal | undefined;
}

interface PreparedTurn {
  context: ChatMessage[];
  system: string;
  userMessage: MessageView;
  estimatedTokens: number;
}

/**
 * Everything both the streaming and non-streaming paths need to do before a
 * single token is generated: persist the user's message, assemble the
 * context window, and fold anything evicted into the thread's summary.
 *
 * Shared deliberately — the two paths differing in how they build context
 * would mean the same question gets a different answer depending on which
 * endpoint the client called.
 */
async function prepareTurn(input: SendInput, provider: LLMProvider): Promise<PreparedTurn> {
  await ensureThread(input.threadId, buildTitle(input.message));

  const userMessage = await appendMessage({
    threadId: input.threadId,
    role: "user",
    content: input.message,
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
  });

  const summaryState = await getSummaryState(input.threadId);
  const stored = await recentMessages(
    input.threadId,
    MAX_HISTORY_FETCH,
    summaryState?.summarisedThrough ?? undefined,
  );

  const history: ChatMessage[] = stored.map((m) => ({ role: m.role, content: m.content }));

  const context = buildContext({
    history,
    summary: summaryState?.summary || undefined,
    systemPrompt: SYSTEM_PROMPT,
    budget: env.CONTEXT_BUDGET_TOKENS,
  });

  // Summarisation happens inline rather than in a background job. That is a
  // deliberate simplification for a single-instance deployment: a queue would
  // be the right answer at scale, but it is real infrastructure to run and
  // this only triggers on long threads.
  if (context.evicted.length > 0) {
    const merged = await summarise({
      previousSummary: summaryState?.summary || undefined,
      evicted: context.evicted,
      provider,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (merged) {
      // The cutoff is the newest evicted message. Everything at or before it
      // is now represented in the summary and will not be loaded again.
      const boundary = stored[context.evicted.length - 1];
      if (boundary) {
        await updateSummary(input.threadId, merged, boundary.createdAt);
        logger.info(
          { threadId: input.threadId, evicted: context.evicted.length },
          "context evicted into summary",
        );
      }
    }
  }

  return {
    context: context.messages,
    system: context.system,
    userMessage,
    estimatedTokens: context.estimatedTokens,
  };
}

export interface SendResult {
  reply: string;
  messageId: string;
  provider: string;
  model: string;
}

export async function sendMessage(
  input: SendInput,
  provider: LLMProvider = chatProvider,
): Promise<SendResult> {
  const turn = await prepareTurn(input, provider);

  const result = await provider.generate({
    system: turn.system,
    messages: turn.context,
    temperature: 0.7,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const assistant = await appendMessage({
    threadId: input.threadId,
    role: "assistant",
    content: result.text,
    status: "complete",
    provider: result.provider,
    model: result.model,
    usage: result.usage,
  });

  return {
    reply: result.text,
    messageId: assistant.id,
    provider: result.provider,
    model: result.model,
  };
}

export type ChatStreamEvent =
  | { type: "message"; messageId: string }
  | { type: "delta"; text: string }
  | { type: "done"; messageId: string; provider: string; model: string }
  | { type: "error"; message: string; messageId: string };

/**
 * Streams a reply, persisting it as it arrives.
 *
 * The assistant's row is written before generation starts, in `streaming`
 * state, and updated as tokens accumulate. That ordering is what makes a
 * dropped connection survivable: whatever arrived is already on disk and
 * honestly labelled `incomplete`, rather than being lost entirely or — worse
 * — saved as though it were a finished answer.
 */
export async function* streamMessage(
  input: SendInput,
  provider: LLMProvider = chatProvider,
): AsyncGenerator<ChatStreamEvent, void, undefined> {
  const turn = await prepareTurn(input, provider);

  const messageId = await beginStreamingMessage(input.threadId);
  yield { type: "message", messageId };

  let accumulated = "";
  let provider_ = "";
  let model = "";

  try {
    for await (const event of provider.stream({
      system: turn.system,
      messages: turn.context,
      temperature: 0.7,
      ...(input.signal ? { signal: input.signal } : {}),
    })) {
      if (event.type === "delta") {
        accumulated += event.text;
        yield { type: "delta", text: event.text };
      } else {
        provider_ = event.provider;
        model = event.model;
        await finaliseMessage(messageId, {
          content: accumulated,
          status: "complete",
          provider: event.provider,
          model: event.model,
          usage: event.usage,
        });
      }
    }

    yield { type: "done", messageId, provider: provider_, model };
  } catch (err) {
    // Distinguish "the user walked away" from "generation broke". Both leave
    // a partial message, but only the second is worth alerting on.
    const aborted = input.signal?.aborted === true;

    await finaliseMessage(messageId, {
      content: accumulated,
      // Text that arrived is kept and marked incomplete; nothing at all is a
      // failure, and replaying an empty assistant turn would poison the next
      // request's context.
      status: accumulated.length > 0 ? "incomplete" : "failed",
    });

    logger[aborted ? "info" : "error"](
      { err, threadId: input.threadId, chars: accumulated.length },
      aborted ? "stream cancelled by client" : "stream failed",
    );

    if (!aborted) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : "Generation failed",
        messageId,
      };
    }
  }
}

function buildTitle(message: string, maxLength = 60): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;

  const cut = collapsed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
