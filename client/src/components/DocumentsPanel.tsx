import { useCallback, useEffect, useRef, useState } from "react";
import { documents } from "@/api/endpoints";
import { ApiError } from "@/api/client";
import type { DocumentSummary } from "@/api/types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentsPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<DocumentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await documents.list();
      setItems(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load documents");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Poll only while something is actually being processed, and stop as soon
   * as nothing is. A fixed interval would keep hitting the API forever for a
   * panel that is not changing.
   */
  useEffect(() => {
    const working = items.some((d) => d.status === "pending" || d.status === "processing");
    if (!working) return;

    const timer = setInterval(() => void load(), 2_000);
    return () => clearInterval(timer);
  }, [items, load]);

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      setUploading(true);

      try {
        await documents.upload(file);
        await load();
      } catch (err) {
        setError(
          err instanceof ApiError ? err.message : "Upload failed. Please try again.",
        );
      } finally {
        setUploading(false);
      }
    },
    [load],
  );

  async function remove(id: string) {
    // Optimistic: the row disappears immediately, and is restored by the
    // reload if the delete actually failed.
    setItems((current) => current.filter((d) => d.id !== id));
    try {
      await documents.remove(id);
    } catch {
      await load();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-paper-300 px-4 py-3 dark:border-night-700">
        <h2 className="text-sm font-semibold">Documents</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close documents panel"
          className="rounded-lg p-1.5 text-ink-400 transition hover:bg-paper-200 dark:hover:bg-night-700"
        >
          ✕
        </button>
      </header>

      <div className="p-4">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void upload(file);
          }}
          className={`rounded-xl border-2 border-dashed p-6 text-center transition ${
            dragging
              ? "border-accent-500 bg-accent-400/10"
              : "border-paper-300 dark:border-night-700"
          }`}
        >
          <p className="text-sm text-ink-600 dark:text-ink-400">
            Drop a PDF, text or markdown file
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="mt-2 text-sm font-medium text-accent-600 underline underline-offset-2 disabled:opacity-50 dark:text-accent-400"
          >
            {uploading ? "Uploading…" : "or choose a file"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              // Reset, or selecting the same file twice fires no change event.
              event.target.value = "";
            }}
          />
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-200">
            {error}
          </p>
        )}
      </div>

      <ul className="flex-1 space-y-1 overflow-y-auto px-2 pb-4">
        {items.length === 0 && (
          <li className="px-2 py-8 text-center text-sm text-ink-400">
            Nothing uploaded yet. Answers will come from general knowledge until you add
            something.
          </li>
        )}

        {items.map((document) => (
          <li
            key={document.id}
            className="group rounded-lg px-2 py-2 transition hover:bg-paper-200 dark:hover:bg-night-800"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{document.filename}</p>
                <p className="mt-0.5 text-xs text-ink-400">
                  <StatusLabel document={document} /> · {formatBytes(document.bytes)}
                </p>
                {document.error && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">{document.error}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void remove(document.id)}
                aria-label={`Delete ${document.filename}`}
                className="shrink-0 rounded p-1 text-ink-400 opacity-0 transition group-hover:opacity-100 hover:text-red-600 focus-visible:opacity-100"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusLabel({ document }: { document: DocumentSummary }) {
  switch (document.status) {
    case "ready":
      return <span className="text-emerald-600 dark:text-emerald-400">{document.chunkCount} passages</span>;
    case "failed":
      return <span className="text-red-600 dark:text-red-400">Failed</span>;
    default:
      return <span className="text-accent-600 dark:text-accent-400">Processing…</span>;
  }
}
