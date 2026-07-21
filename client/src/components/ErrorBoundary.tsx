import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors so one broken component does not blank the page.
 *
 * Without a boundary, React unmounts the entire tree on an uncaught render
 * error and the user is left staring at white. That is the difference
 * between "the message list failed to draw" and "the app is gone".
 *
 * Still a class component: there is no hook equivalent, because hooks cannot
 * implement componentDidCatch.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Where Sentry is wired in. Logged for now so the stack is not lost.
    console.error("Render error:", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-lg font-medium">Something broke on this screen.</p>
        <p className="max-w-md text-sm text-ink-600 dark:text-ink-400">
          The rest of the app is still running. You can try rendering this part again.
        </p>
        <button
          type="button"
          onClick={this.reset}
          className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-night-900 transition hover:bg-accent-400"
        >
          Try again
        </button>
      </div>
    );
  }
}
