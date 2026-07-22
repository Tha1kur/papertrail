import { createContext } from "react";

export type Theme = "light" | "dark";

export interface ThemeState {
  theme: Theme;
  toggle: () => void;
}

/** Separate from the provider component so Fast Refresh keeps working —
 *  see authContext.ts for why. */
export const ThemeContext = createContext<ThemeState | null>(null);

export const THEME_STORAGE_KEY = "papertrail-theme";
