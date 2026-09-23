"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

/** Blocking pre-paint script: dark unless the visitor chose light. */
export const THEME_SCRIPT = `try{if(localStorage.getItem('theme')==='light'){document.documentElement.classList.remove('dark')}else{document.documentElement.classList.add('dark')}}catch(e){document.documentElement.classList.add('dark')}`;

const subscribe = (onChange: () => void) => {
  window.addEventListener("themechange", onChange);
  return () => window.removeEventListener("themechange", onChange);
};

/** Flips `.dark` on <html>, persists it, and emits `themechange` so the canvas chart repaints. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const dark = useSyncExternalStore(subscribe, () => document.documentElement.classList.contains("dark"), () => true);

  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* storage blocked */ }
    window.dispatchEvent(new Event("themechange"));
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      className={`inline-flex h-8 w-8 items-center justify-center rounded text-[var(--t-text-2)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)] ${className}`}
    >
      {dark ? <Moon className="h-4 w-4" strokeWidth={1.75} /> : <Sun className="h-4 w-4" strokeWidth={1.75} />}
    </button>
  );
}
