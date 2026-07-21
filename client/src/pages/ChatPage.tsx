import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { MessageList } from "@/components/MessageList";
import { Composer } from "@/components/Composer";
import { DocumentsPanel } from "@/components/DocumentsPanel";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useChat } from "@/hooks/useChat";
import { threads as threadsApi, usage as usageApi } from "@/api/endpoints";
import type { Thread, Usage } from "@/api/types";

export function ChatPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string>(() => crypto.randomUUID());
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);

  const refreshThreads = useCallback(async () => {
    try {
      const page = await threadsApi.list();
      setThreads(page.items);
    } catch {
      // A failed sidebar refresh must not break the conversation in progress.
    }
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await usageApi.today());
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    void refreshThreads();
    void refreshUsage();
  }, [refreshThreads, refreshUsage]);

  const onFirstMessage = useCallback(() => {
    void refreshThreads();
    void refreshUsage();
  }, [refreshThreads, refreshUsage]);

  const chat = useChat(activeId, onFirstMessage);

  function startNew() {
    // The id is minted client-side, so a new conversation exists instantly
    // with no server round trip. The thread row is created on first send.
    setActiveId(crypto.randomUUID());
    setSidebarOpen(false);
  }

  function select(id: string) {
    setActiveId(id);
    setSidebarOpen(false);
  }

  async function remove(id: string) {
    setThreads((current) => current.filter((t) => t.id !== id));
    if (id === activeId) startNew();

    try {
      await threadsApi.remove(id);
    } catch {
      await refreshThreads();
    }
  }

  async function rename(id: string, title: string) {
    setThreads((current) => current.map((t) => (t.id === id ? { ...t, title } : t)));
    try {
      await threadsApi.rename(id, title);
    } catch {
      await refreshThreads();
    }
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Off-canvas below md, static above. One component, two behaviours,
          rather than a separate mobile tree that drifts out of sync. */}
      <div
        className={`fixed inset-y-0 left-0 z-40 transition-transform md:static md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar
          threads={threads}
          activeId={activeId}
          usage={usage}
          onSelect={select}
          onNew={startNew}
          onDelete={(id) => void remove(id)}
          onRename={(id, title) => void rename(id, title)}
          onOpenDocuments={() => {
            setDocumentsOpen(true);
            setSidebarOpen(false);
          }}
          onClose={() => setSidebarOpen(false)}
        />
      </div>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-night-900/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-paper-300 px-4 py-3 md:hidden dark:border-night-700">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="rounded-lg p-1.5 transition hover:bg-paper-200 dark:hover:bg-night-800"
          >
            ☰
          </button>
          <span className="font-semibold tracking-tight">PaperTrail</span>
        </header>

        <ErrorBoundary>
          {chat.loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-ink-400">
              Loading…
            </div>
          ) : chat.messages.length === 0 ? (
            <EmptyState onOpenDocuments={() => setDocumentsOpen(true)} />
          ) : (
            <MessageList messages={chat.messages} streaming={chat.streaming} />
          )}
        </ErrorBoundary>

        {chat.error && (
          <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
            <div
              role="alert"
              className="mb-2 flex items-center justify-between gap-3 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-200"
            >
              <span>
                {chat.error}
                {chat.retryAfter !== null && ` (retry in ${chat.retryAfter}s)`}
              </span>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={chat.retry} className="font-medium underline">
                  Retry
                </button>
                <button type="button" onClick={chat.clearError} aria-label="Dismiss error">
                  ✕
                </button>
              </div>
            </div>
          </div>
        )}

        <Composer onSend={(text) => void chat.send(text)} onStop={chat.stop} streaming={chat.streaming} />
      </main>

      {documentsOpen && (
        <>
          <div
            className="fixed inset-0 z-30 bg-night-900/40 lg:hidden"
            onClick={() => setDocumentsOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 right-0 z-40 w-full max-w-sm border-l border-paper-300 bg-paper-50 lg:static dark:border-night-700 dark:bg-night-850">
            <ErrorBoundary>
              <DocumentsPanel onClose={() => setDocumentsOpen(false)} />
            </ErrorBoundary>
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState({ onOpenDocuments }: { onOpenDocuments: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="text-4xl" aria-hidden="true">
        📎
      </div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Ask your documents</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-600 dark:text-ink-400">
        Upload a PDF or notes, then ask questions about them. Every answer cites the passage it
        came from, so you can check it.
      </p>
      <button
        type="button"
        onClick={onOpenDocuments}
        className="mt-5 rounded-lg border border-paper-300 px-4 py-2 text-sm font-medium transition hover:bg-paper-200 dark:border-night-700 dark:hover:bg-night-800"
      >
        Upload a document
      </button>
    </div>
  );
}
