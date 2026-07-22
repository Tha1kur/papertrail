import { AuthProvider } from "@/context/AuthProvider";
import { useAuth } from "@/context/useAuth";
import { ThemeProvider } from "@/context/ThemeProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthPage } from "@/pages/AuthPage";
import { ChatPage } from "@/pages/ChatPage";

function Routes() {
  const { user, loading } = useAuth();

  /**
   * Rendering nothing while the session is being checked, rather than
   * defaulting to the sign-in page.
   *
   * `!user` cannot distinguish "signed out" from "we have not asked yet", and
   * treating them the same is why so many apps flash a login screen for a
   * moment on every reload.
   */
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <span className="sr-only">Loading</span>
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-paper-300 border-t-accent-500" />
      </div>
    );
  }

  return user ? <ChatPage /> : <AuthPage />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <Routes />
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
