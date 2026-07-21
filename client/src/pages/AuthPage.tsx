import { useState, type FormEvent } from "react";
import { useAuth } from "@/context/useAuth";
import { ApiError } from "@/api/client";

export function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === "register";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (isRegister) await register(email, password);
      else await login(email, password);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Something went wrong. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-3xl" aria-hidden="true">
            📎
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">PaperTrail</h1>
          <p className="mt-1 text-sm text-ink-600 dark:text-ink-400">
            Ask your documents. Get answers you can check.
          </p>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="space-y-4 rounded-2xl border border-paper-300 bg-paper-50 p-6 dark:border-night-700 dark:bg-night-850"
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              // Tells password managers what this form is for, so they offer
              // to save and fill correctly.
              autoComplete="email"
              className="mt-1.5 w-full rounded-lg border border-paper-300 bg-paper-100 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none dark:border-night-700 dark:bg-night-800"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={isRegister ? 12 : undefined}
              autoComplete={isRegister ? "new-password" : "current-password"}
              className="mt-1.5 w-full rounded-lg border border-paper-300 bg-paper-100 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none dark:border-night-700 dark:bg-night-800"
            />
            {isRegister && (
              <p className="mt-1.5 text-xs text-ink-400">
                At least 12 characters. Length matters more than symbols.
              </p>
            )}
          </div>

          {error && (
            // role=alert so a screen reader announces it without the user
            // having to go looking for what changed.
            <p
              role="alert"
              className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-200"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-medium text-night-900 transition hover:bg-accent-400 disabled:opacity-50"
          >
            {submitting ? "…" : isRegister ? "Create account" : "Sign in"}
          </button>

          <p className="text-center text-sm text-ink-600 dark:text-ink-400">
            {isRegister ? "Already have an account?" : "No account yet?"}{" "}
            <button
              type="button"
              onClick={() => {
                setMode(isRegister ? "login" : "register");
                setError(null);
              }}
              className="font-medium text-accent-600 underline underline-offset-2 dark:text-accent-400"
            >
              {isRegister ? "Sign in" : "Create one"}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
