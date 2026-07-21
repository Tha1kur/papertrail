import { useContext } from "react";
import { AuthContext, type AuthState } from "./AuthContext";

/**
 * Lives apart from AuthContext.tsx so that file exports only components.
 * Mixing hooks and components in one module breaks React Fast Refresh —
 * editing the provider forces a full reload and loses application state.
 */
export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}
