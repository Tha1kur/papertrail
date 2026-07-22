import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeContext, THEME_STORAGE_KEY, type Theme } from "./themeContext";

/** Read synchronously during the first render so the page never paints in
 *  the wrong theme and then snaps — the flash-of-wrong-theme problem. */
function initialTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;

  // No explicit choice: follow the operating system.
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  // Follow the OS while the user has not expressed a preference of their own.
  useEffect(() => {
    if (localStorage.getItem(THEME_STORAGE_KEY)) return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setTheme(event.matches ? "dark" : "light");

    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
