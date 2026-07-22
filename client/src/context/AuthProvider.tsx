import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { auth } from "@/api/endpoints";
import { setSessionExpiredHandler } from "@/api/client";
import type { User } from "@/api/types";
import { AuthContext } from "./authContext";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Session state cannot be read from the cookie — it is httpOnly, which is
   * the point. So the app asks the server who it is on load. That one round
   * trip is the cost of not being able to steal the token with XSS.
   */
  useEffect(() => {
    let cancelled = false;

    auth
      .me()
      .then((response) => {
        if (!cancelled) setUser(response.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // The API client cannot import this context without a cycle, so it calls
  // back through a registered handler when a refresh finally fails.
  useEffect(() => {
    setSessionExpiredHandler(() => setUser(null));
    return () => setSessionExpiredHandler(() => {});
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const response = await auth.login(email, password);
    setUser(response.user);
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName?: string) => {
      const response = await auth.register(email, password, displayName);
      setUser(response.user);
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await auth.logout();
    } finally {
      // Cleared even if the request fails. The user asked to be signed out;
      // leaving them apparently signed in because the network hiccuped is
      // both confusing and, on a shared machine, unsafe.
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
