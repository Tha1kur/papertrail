import { Suspense, lazy, memo, useEffect, useRef } from "react";
import type { Citation, Message } from "@/api/types";

// Roughly 330 kB of markdown and syntax-highlighting machinery, kept off the
// critical path. See components/Markdown.tsx for the measurements.
const Markdown = lazy(() => import("./Markdown"));

interface DisplayMessage extends Message {
  pending?: boolean;
  failed?: boolean;
}

interface Props {
  messages: DisplayMessage[];
  streaming: boolean;
}

export function MessageList({ messages, streaming }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  /**
   * Follow new output, but only while the user is already at the bottom.
   *
   * Scrolling unconditionally is the common version of this and it is
   * hostile: someone reading back through the conversation gets yanked to
   * the end on every token.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onScroll = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      pinnedRef.current = distance < 120;
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto overscroll-contain"
      // Announces streamed output to screen readers without stealing focus.
      aria-live="polite"
      aria-busy={streaming}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

/**
 * memo because a streaming reply re-renders the list on every token. Without
 * it, a hundred settled messages re-render a hundred times for one answer.
 */
const MessageBubble = memo(function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          className={`max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] whitespace-pre-wrap ${
            message.failed
              ? "bg-red-100 text-red-900 dark:bg-red-950/50 dark:text-red-200"
              : "bg-ink-900 text-paper-100 dark:bg-paper-200 dark:text-ink-900"
          } ${message.pending ? "opacity-70" : ""}`}
        >
          {message.content}
        </div>
      </div>
    );
  }

  const isStreaming = message.status === "streaming";

  return (
    <div className="flex flex-col gap-2">
      <div
        className={`prose-chat max-w-none ${isStreaming && message.content.length > 0 ? "streaming-caret" : ""}`}
      >
        {message.content.length === 0 && isStreaming ? (
          <ThinkingDots />
        ) : (
          // The fallback is the raw text, not a spinner: it is readable, it
          // is the same words, and it swaps to formatted output the moment
          // the chunk arrives. A spinner would hide content we already have.
          <Suspense fallback={<span className="whitespace-pre-wrap">{message.content}</span>}>
            <Markdown content={message.content} />
          </Suspense>
        )}
      </div>

      {message.status === "incomplete" && (
        <p className="text-xs text-ink-400">Response was interrupted.</p>
      )}

      {message.citations && message.citations.length > 0 && (
        <Citations citations={message.citations} />
      )}
    </div>
  );
});

function Citations({ citations }: { citations: Citation[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <span className="text-xs font-medium text-ink-400">Sources</span>
      {citations.map((citation, index) => (
        <span
          key={citation.chunkId}
          className="inline-flex items-center gap-1.5 rounded-full border border-accent-500/30 bg-accent-400/10 px-2.5 py-1 text-xs text-ink-600 dark:text-paper-200"
          title={
            citation.score !== undefined
              ? `Relevance ${(citation.score * 100).toFixed(1)}%`
              : undefined
          }
        >
          <span className="font-mono text-accent-600 dark:text-accent-400">[{index + 1}]</span>
          <span className="max-w-[16rem] truncate">{citation.filename}</span>
          {citation.page !== undefined && (
            <span className="text-ink-400">p.{citation.page}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1" aria-label="Generating a reply">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-ink-400"
          style={{ animation: `caret 1.2s ${i * 0.15}s infinite` }}
        />
      ))}
    </div>
  );
}
