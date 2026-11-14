"use client";
import { useEffect, useState } from "react";
import { THEME_KEY, type Theme } from "@/lib/theme";

// The header toggle: changes and saves the theme. The first paint is set by THEME_BOOT (lib/theme.ts), inline in <head>.
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => { setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark"); }, []);
  const flip = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { console.warn("theme choice not saved", e); }
    setTheme(next);
  };
  const light = theme === "light";
  return (
    <button className="btn icon theme-btn" onClick={flip} aria-pressed={light} aria-label={light ? "Switch to dark mode" : "Switch to light mode"}
      title={light ? "Dark mode" : "Light mode"}>
      {light
        ? <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
        : <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3 3l1.3 1.3M11.7 11.7 13 13M3 13l1.3-1.3M11.7 4.3 13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>}
    </button>);
}
