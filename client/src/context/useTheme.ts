import { useContext } from "react";
import { ThemeContext, type ThemeState } from "./themeContext";

export function useTheme(): ThemeState {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}
