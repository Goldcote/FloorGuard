import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "floorguard.theme";

function stored(): Theme | undefined {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Dark ("a vault at night") is the look a first-time visitor gets; the toggle switches to the light
 * theme and the choice is remembered in this browser. The value is set as `data-theme` on <html>,
 * which the colour tokens key off; index.html sets it before first paint.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#05070b" : "#f3efe6");
  }, [theme]);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // private mode: the choice lasts for this page view only
    }
  };
  return { theme, toggle };
}
