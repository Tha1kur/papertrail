import { createContext } from "react";
import type { User } from "@/api/types";

/**
 * Context object and its type, kept apart from the provider component.
 *
 * A module exporting both a component and a non-component breaks React Fast
 * Refresh: editing the provider forces a full page reload instead of a hot
 * swap, and every piece of application state is lost. Splitting them means
 * each file exports one kind of thing.
 */
export interface AuthState {
  user: User | null;
  /** True until the first session check finishes. Distinct from `!user`,
   *  which cannot tell "not logged in" from "we do not know yet" — routing
   *  on that difference is what causes a login screen to flash on reload. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);
