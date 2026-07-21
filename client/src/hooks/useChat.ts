import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat } from "@/api/stream";
import { threads } from "@/api/endpoints";
import { ApiError } from "@/api/client";
import type { Message } from "@/api/types";

/** A message not yet acknowledged by the server, rendered immediately. */
interface PendingMessage extends Omit<Message, "id"> {
  id: string;
  pending?: boolean;
  failed?: boolean;
}

interface ChatState {
  messages: PendingMessage[];
  streaming: boolean;
  loading: boolean;
  error: string | null;
  retryAfter: number | null;
  send: (text: string) => Promise<void>;
  stop: () => void;
  retry: () => void;
  clearError: () => void;
}

export function useChat(threadId: string, onFirstMessage?: () => void): ChatState {
  const [messages, setMessages] = useState<PendingMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const lastSentRef = useRef<string | null>(null);
  const notifiedRef = useRef(false);

  // Load history when the thread changes.
  useEffect(() => {
    let cancelled = false;
    notifiedRef.current = false;

    setMessages([]);
    setError(null);
    setLoading(true);

    threads
      .messages(threadId)
      .then((page) => {
        if (!cancelled) setMessages(page.items);
      })
      .catch((err: unknown) => {
        // A thread that does not exist yet is the normal case for a new
        // chat, not an error worth showing.
        if (!cancelled && !(err instanceof ApiError && err.status === 404)) {
          setError(err instanceof Error ? err.message : "Could not load messages");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  /**
   * Aborts any in-flight stream when the thread changes or the component
   * unmounts.
   *
   * Without this, navigating away leaves the request running: the server
   * keeps generating, tokens keep being spent, and deltas keep arriving for
   * a thread nobody is looking at — which React then warns about as a state
   * update on an unmounted component.
   */
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [threadId]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || streaming) return;

      setError(null);
      setRetryAfter(null);
      lastSentRef.current = trimmed;

      // Generated here, sent with the request, and reused on retry — this is
      // what stops a retry after a timeout creating a second message and a
      // second model call.
      const clientMessageId = crypto.randomUUID();
      const now = new Date().toISOString();

      const optimisticUser: PendingMessage = {
        id: `local-${clientMessageId}`,
        threadId,
        role: "user",
        content: trimmed,
        status: "complete",
        createdAt: now,
        pending: true,
      };

      const placeholder: PendingMessage = {
        id: `local-assistant-${clientMessageId}`,
        threadId,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: now,
      };

      // Both appear instantly. Waiting for the server before showing the
      // user their own words makes the app feel broken on a slow connection.
      setMessages((current) => [...current, optimisticUser, placeholder]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        for await (const event of streamChat({
          threadId,
          message: trimmed,
          clientMessageId,
          signal: controller.signal,
        })) {
          if (event.type === "message") {
            const { messageId, citations } = event;
            setMessages((current) =>
              current.map((m) =>
                m.id === placeholder.id ? { ...m, id: messageId, citations } : m,
              ),
            );
          } else if (event.type === "delta") {
            const { text: delta } = event;
            setMessages((current) =>
              current.map((m) =>
                m.role === "assistant" && m.status === "streaming"
                  ? { ...m, content: m.content + delta }
                  : m,
              ),
            );
          } else if (event.type === "done") {
            setMessages((current) =>
              current.map((m) =>
                m.status === "streaming" ? { ...m, status: "complete" as const } : m,
              ),
            );
          } else {
            setError(event.message);
            setMessages((current) =>
              current.map((m) =>
                m.status === "streaming" ? { ...m, status: "incomplete" as const } : m,
              ),
            );
          }
        }

        setMessages((current) => current.map((m) => ({ ...m, pending: false })));

        // The sidebar needs to learn the thread now exists and has a title.
        if (!notifiedRef.current) {
          notifiedRef.current = true;
          onFirstMessage?.();
        }
      } catch (err) {
        // A user-initiated stop is not a failure; whatever arrived stays put.
        if (controller.signal.aborted) {
          setMessages((current) =>
            current.map((m) =>
              m.status === "streaming" ? { ...m, status: "incomplete" as const } : m,
            ),
          );
        } else {
          const apiError = err instanceof ApiError ? err : null;
          setError(apiError?.message ?? "Something went wrong. Please try again.");
          setRetryAfter(apiError?.retryAfterSeconds ?? null);

          setMessages((current) =>
            current
              // The empty placeholder is noise once generation failed.
              .filter((m) => !(m.id === placeholder.id && m.content.length === 0))
              .map((m) => (m.id === optimisticUser.id ? { ...m, failed: true } : m)),
          );
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [threadId, streaming, onFirstMessage],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const retry = useCallback(() => {
    const last = lastSentRef.current;
    if (!last) return;

    // Drop the failed exchange before resending, so the thread does not
    // accumulate a visible history of attempts.
    setMessages((current) => current.filter((m) => !m.failed));
    void send(last);
  }, [send]);

  const clearError = useCallback(() => setError(null), []);

  return { messages, streaming, loading, error, retryAfter, send, stop, retry, clearError };
}
