"use client";

import { useEffect } from "react";

/** Keep the browser tab icon aligned with the app's manual theme toggle. */
export function ThemeFavicon() {
  useEffect(() => {
    const update = () => {
      const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (icon) icon.href = document.documentElement.classList.contains("dark")
        ? "/brand/equinox-dark.png"
        : "/brand/equinox-light.png";
    };

    update();
    window.addEventListener("themechange", update);
    return () => window.removeEventListener("themechange", update);
  }, []);

  return null;
}
