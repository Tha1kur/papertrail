import { useState } from "react";
import { useAuth } from "@/context/useAuth";
import { useTheme } from "@/context/useTheme";
import type { Thread, Usage } from "@/api/types";

interface Props {
  threads: Thread[];
  activeId: string;
  usage: Usage | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onOpenDocuments: () => void;
  onClose: () => void;
}

export function Sidebar({
  threads,
  activeId,
  usage,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onOpenDocuments,
  onClose,
}: Props) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function commitRename(id: string) {
    const title = draft.trim();
    if (title.length > 0) onRename(id, title);
    setEditingId(null);
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-paper-300 bg-paper-50 dark:border-night-700 dark:bg-night-850">
      <div className="flex items-center justify-between px-4 py-4">
        <div className="flex items-center gap-2">
          <span className="text-lg" aria-hidden="true">
            📎
          </span>
          <span className="font-semibold tracking-tight">PaperTrail</span>
        </div>
        {/* Only reachable on mobile, where the sidebar is an overlay. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close menu"
          className="rounded-lg p-1.5 text-ink-400 transition hover:bg-paper-200 md:hidden dark:hover:bg-night-700"
        >
          ✕
        </button>
      </div>

      <div className="space-y-1 px-3">
        <button
          type="button"
          onClick={onNew}
          className="w-full rounded-lg bg-accent-500 px-3 py-2 text-sm font-medium text-night-900 transition hover:bg-accent-400"
        >
          New chat
        </button>
        <button
          type="button"
          onClick={onOpenDocuments}
          className="w-full rounded-lg border border-paper-300 px-3 py-2 text-sm font-medium transition hover:bg-paper-200 dark:border-night-700 dark:hover:bg-night-800"
        >
          Documents
        </button>
      </div>

      <nav className="mt-4 flex-1 overflow-y-auto px-2" aria-label="Conversations">
        {threads.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-ink-400">No conversations yet.</p>
        )}

        <ul className="space-y-0.5">
          {threads.map((thread) => {
            const active = thread.id === activeId;

            return (
              <li key={thread.id}>
                {editingId === thread.id ? (
                  <input
                    value={draft}
                    // Focus via a callback ref rather than autoFocus: the
                    // intent is "focus this field the user just opened", not
                    // "steal focus on page load", which is what the a11y rule
                    // is guarding against.
                    ref={(node) => node?.focus()}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commitRename(thread.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename(thread.id);
                      if (event.key === "Escape") setEditingId(null);
                    }}
                    className="w-full rounded-lg border border-accent-500 bg-transparent px-3 py-2 text-sm focus:outline-none"
                  />
                ) : (
                  <div
                    className={`group flex items-center gap-1 rounded-lg transition ${
                      active
                        ? "bg-paper-200 dark:bg-night-800"
                        : "hover:bg-paper-200 dark:hover:bg-night-800"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(thread.id)}
                      aria-current={active ? "page" : undefined}
                      className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm"
                    >
                      {thread.title}
                    </button>

                    {/* Hidden until hover to keep the list calm, but revealed
                        on keyboard focus so they are not mouse-only. */}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(thread.id);
                        setDraft(thread.title);
                      }}
                      aria-label={`Rename ${thread.title}`}
                      className="rounded p-1 text-ink-400 opacity-0 transition group-hover:opacity-100 hover:text-ink-900 focus-visible:opacity-100 dark:hover:text-paper-200"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(thread.id)}
                      aria-label={`Delete ${thread.title}`}
                      className="mr-1 rounded p-1 text-ink-400 opacity-0 transition group-hover:opacity-100 hover:text-red-600 focus-visible:opacity-100"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-paper-300 p-3 dark:border-night-700">
        {usage && (
          <div className="mb-3 px-1">
            <div className="flex items-center justify-between text-xs text-ink-400">
              <span>Daily usage</span>
              <span>{usage.percentUsed}%</span>
            </div>
            <div
              className="mt-1 h-1 overflow-hidden rounded-full bg-paper-300 dark:bg-night-700"
              role="progressbar"
              aria-valuenow={usage.percentUsed}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Daily token usage"
            >
              <div
                className={`h-full transition-all ${
                  usage.percentUsed > 90 ? "bg-red-500" : "bg-accent-500"
                }`}
                style={{ width: `${usage.percentUsed}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-ink-400" title={user?.email}>
            {user?.email}
          </span>
          <button
            type="button"
            onClick={toggle}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            className="rounded-lg p-1.5 transition hover:bg-paper-200 dark:hover:bg-night-700"
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            className="rounded-lg px-2 py-1.5 text-xs transition hover:bg-paper-200 dark:hover:bg-night-700"
          >
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
