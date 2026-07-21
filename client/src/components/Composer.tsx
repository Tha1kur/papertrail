import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
}

const MAX_LENGTH = 8_000;

export function Composer({ onSend, onStop, streaming, disabled }: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the content, up to a ceiling — beyond that the textarea would
  // push the conversation off screen entirely.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [value]);

  // Return focus after a reply finishes, so the next message can be typed
  // without reaching for the mouse.
  useEffect(() => {
    if (!streaming) textareaRef.current?.focus();
  }, [streaming]);

  function submit() {
    const trimmed = value.trim();
    if (trimmed.length === 0 || streaming || disabled) return;

    onSend(trimmed);
    setValue("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter breaks the line — the convention every chat
    // app uses, and violating it makes the app feel wrong immediately.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  const remaining = MAX_LENGTH - value.length;
  const nearLimit = remaining < 500;

  return (
    <div className="border-t border-paper-300 bg-paper-100/80 backdrop-blur dark:border-night-700 dark:bg-night-900/80">
      <form onSubmit={handleSubmit} className="mx-auto max-w-3xl px-4 py-4 sm:px-6">
        <div className="flex items-end gap-2 rounded-2xl border border-paper-300 bg-paper-50 p-2 transition focus-within:border-accent-500 dark:border-night-700 dark:bg-night-800">
          <label htmlFor="composer" className="sr-only">
            Message
          </label>
          <textarea
            id="composer"
            ref={textareaRef}
            value={value}
            onChange={(event) => setValue(event.target.value.slice(0, MAX_LENGTH))}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={disabled}
            placeholder={disabled ? "Unavailable" : "Ask about your documents…"}
            className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] placeholder:text-ink-400 focus:outline-none disabled:opacity-50"
          />

          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              className="shrink-0 rounded-xl border border-paper-300 px-3 py-2 text-sm font-medium transition hover:bg-paper-200 dark:border-night-700 dark:hover:bg-night-700"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={value.trim().length === 0 || disabled}
              aria-label="Send message"
              className="shrink-0 rounded-xl bg-accent-500 px-3.5 py-2 text-sm font-medium text-night-900 transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between px-1 text-xs text-ink-400">
          <span>
            <kbd className="font-sans">Enter</kbd> to send ·{" "}
            <kbd className="font-sans">Shift+Enter</kbd> for a new line
          </span>
          {nearLimit && <span className={remaining < 100 ? "text-red-500" : ""}>{remaining}</span>}
        </div>
      </form>
    </div>
  );
}
