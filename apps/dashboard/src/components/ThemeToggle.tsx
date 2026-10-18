"use client";

import React, { useEffect, useState } from "react";
import { LuSun, LuMoon } from "react-icons/lu";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem("synapse_theme");
    if (stored === "dark" || stored === "light") {
      setTheme(stored);
      applyTheme(stored);
    } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      setTheme("dark");
      applyTheme("dark");
    } else {
      setTheme("light");
      applyTheme("light");
    }
  }, []);

  const applyTheme = (t: "light" | "dark") => {
    const root = document.documentElement;
    if (t === "dark") {
      root.classList.add("dark");
      root.setAttribute("data-theme", "dark");
    } else {
      root.classList.remove("dark");
      root.setAttribute("data-theme", "light");
    }
  };

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("synapse_theme", next);
    applyTheme(next);
  };

  // Prevent hydration mismatch: render placeholder until mounted
  if (!mounted) {
    return (
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "var(--radius-full)",
          backgroundColor: "transparent",
        }}
      />
    );
  }

  return (
    <button
      id="theme-toggle-btn"
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      style={{
        width: "36px",
        height: "36px",
        borderRadius: "var(--radius-full)",
        border: "1px solid var(--color-hairline)",
        backgroundColor: "var(--color-canvas)",
        color: "var(--color-ink)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        transition: "all 0.15s ease",
      }}
    >
      {theme === "dark" ? (
        <LuSun size={17} color="#ffb703" />
      ) : (
        <LuMoon size={17} color="var(--color-ink-soft)" />
      )}
    </button>
  );
}
