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
  type Citation,
  type MessageView,
} from "../repositories/messageRepository.js";
import { retrieve, formatContext } from "./rag/retrieve.js";
import {
  ensureThread,
  getSummaryState,
  updateSummary,
} from "../repositories/threadRepository.js";
import { recordUsage } from "./limits/budget.js";

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

When passages from the user's documents are supplied you will be told how to
use them. When none are supplied, answer normally from what you know.`;

/**
 * Appended only when passages were actually retrieved.
 *
 * The earlier version of this lived in the base prompt and told the model to
 * say when the documents did not cover a question. That leaked into every
 * conversation: asked the capital of Portugal with no documents in play, it
 * answered "I do not know" — technically obedient, completely useless.
 *
 * Retrieval instructions only make sense when there is something retrieved,
 * so they are attached at that moment and not before.
 */
const RETRIEVAL_INSTRUCTIONS = `Ground your answer in the passages below and cite them inline as [1], [2] and so on, matching the numbers given.

Rules:
- cite only passages you actually used
- if the passages do not answer the question, say so first. You may then
  answer from general knowledge, but state clearly that you are doing so
- never present general knowledge as though it came from the documents`;

/**
 * Upper bound on how many stored messages we will even consider for the
 * context window. The budget usually bites first; this stops a thread with
 * ten thousand messages from loading all of them just to throw most away.
 */
const MAX_HISTORY_FETCH = 200;

export interface SendInput {
  threadId: string;
  userId: string;
  message: string;
  clientMessageId?: string | undefined;
  signal?: AbortSignal | undefined;
}

interface PreparedTurn {
  context: ChatMessage[];
  system: string;
  userMessage: MessageView;
  estimatedTokens: number;
  citations: Citation[];
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
  await ensureThread(input.userId, input.threadId, buildTitle(input.message));

  const userMessage = await appendMessage({
    threadId: input.threadId,
    userId: input.userId,
    role: "user",
    content: input.message,
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
  });

  const summaryState = await getSummaryState(input.userId, input.threadId);
  const stored = await recentMessages(
    input.threadId,
    input.userId,
    MAX_HISTORY_FETCH,
    summaryState?.summarisedThrough ?? undefined,
  );

  const history: ChatMessage[] = stored.map((m) => ({ role: m.role, content: m.content }));

  /**
   * Retrieval runs against the raw user message.
   *
   * A more sophisticated system would rewrite the question first — "what
   * about the second one?" retrieves nothing useful on its own, because the
   * embedding of a pronoun matches nothing. Query rewriting is the known
   * next improvement here; it costs an extra model call per turn, which is
   * why it is not in the first version.
   */
  const retrieved = await retrieve({
    userId: input.userId,
    query: input.message,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  // Two filters. The absolute floor rejects passages that are not about the
  // question at all; the drop-off rejects passages that are merely worse
  // than the best one, so a single strong match is not diluted by five
  // mediocre ones the model would then hedge across.
  const best = retrieved[0]?.score ?? 0;
  const relevant = retrieved.filter(
    (chunk) =>
      chunk.score >= env.RAG_MIN_SCORE && chunk.score >= best - env.RAG_SCORE_DROPOFF,
  );
  const { text: documentContext, used } = formatContext(relevant, env.RAG_CONTEXT_TOKENS);

  const citations: Citation[] = used.map((chunk) => ({
    documentId: chunk.documentId,
    chunkId: chunk.chunkId,
    filename: chunk.filename,
    ...(chunk.page !== null ? { page: chunk.page } : {}),
    score: chunk.score,
  }));

  const systemPrompt = documentContext
    ? `${SYSTEM_PROMPT}\n\n${RETRIEVAL_INSTRUCTIONS}\n\nPassages from the user's documents:\n\n${documentContext}`
    : SYSTEM_PROMPT;

  const context = buildContext({
    history,
    summary: summaryState?.summary || undefined,
    systemPrompt,
    // Retrieved passages have already been charged against the total, so
    // history competes for what is left rather than for the whole budget.
    budget: Math.max(env.CONTEXT_BUDGET_TOKENS - env.RAG_CONTEXT_TOKENS, 1_000),
  });

  if (used.length > 0) {
    logger.info(
      {
        threadId: input.threadId,
        retrieved: retrieved.length,
        aboveThreshold: relevant.length,
        used: used.length,
        topScore: retrieved[0]?.score,
      },
      "retrieved document context",
    );
  }

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
        await updateSummary(input.userId, input.threadId, merged, boundary.createdAt);
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
    citations,
  };
}

export interface SendResult {
  reply: string;
  messageId: string;
  provider: string;
  model: string;
  citations: Citation[];
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
    userId: input.userId,
    role: "assistant",
    content: result.text,
    status: "complete",
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    citations: turn.citations,
  });

  // Recorded after the call, because the cost is only known once it returns.
  // Awaited rather than fired and forgotten: an unawaited write can be lost
  // if the process is shut down between the response and the flush, and the
  // whole point is that spend is never undercounted.
  await recordUsage(input.userId, result.usage);

  return {
    reply: result.text,
    messageId: assistant.id,
    provider: result.provider,
    model: result.model,
    citations: turn.citations,
  };
}

export type ChatStreamEvent =
  | { type: "message"; messageId: string; citations: Citation[] }
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

  const messageId = await beginStreamingMessage(input.threadId, input.userId);
  // Citations are sent up front, before any text. The client can then render
  // the sources immediately and highlight them as the answer refers to them,
  // rather than having them appear after the user has finished reading.
  yield { type: "message", messageId, citations: turn.citations };

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
        await finaliseMessage(messageId, input.userId, {
          content: accumulated,
          status: "complete",
          provider: event.provider,
          model: event.model,
          usage: event.usage,
          citations: turn.citations,
        });
        await recordUsage(input.userId, event.usage);
      }
    }

    yield { type: "done", messageId, provider: provider_, model };
  } catch (err) {
    // Distinguish "the user walked away" from "generation broke". Both leave
    // a partial message, but only the second is worth alerting on.
    const aborted = input.signal?.aborted === true;

    await finaliseMessage(messageId, input.userId, {
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
