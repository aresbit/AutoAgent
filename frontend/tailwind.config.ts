import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        rail: "var(--rail)",
        panel: "var(--panel)",
        popover: "var(--popover)",
        surface: "var(--surface)",
        "panel-2": "var(--panel-2)",
        hover: "var(--hover)",
        selected: "var(--selected)",
        line: "var(--line)",
        "line-strong": "var(--line-strong)",
        ink: "var(--ink)",
        "ink-2": "var(--ink-2)",
        "ink-3": "var(--ink-3)",
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          soft: "var(--accent-soft)",
        },
        "on-accent": "var(--on-accent)",
        ok: "var(--ok)",
        warn: "var(--warn)",
        bad: "var(--bad)",
        info: "var(--info)",
        scrim: "var(--scrim)",
        code: "var(--code-bg)",
        "code-ink": "var(--code-ink)",
        "code-muted": "var(--code-muted)",
        "code-line": "var(--code-line)",
        "code-hover": "var(--code-hover)",
      },
      borderRadius: {
        card: "10px",
        dialog: "16px",
        composer: "20px",
      },
      boxShadow: {
        sm: "var(--sh-sm)",
        panel: "var(--sh-panel)",
        "panel-hover": "var(--sh-panel-hover)",
        popover: "var(--sh-popover)",
        composer: "var(--sh-composer)",
        "composer-hover": "var(--sh-composer-hover)",
        "composer-focus": "var(--sh-composer-focus)",
        focus: "var(--sh-focus)",
        thumb: "var(--sh-thumb)",
      },
      fontFamily: {
        sans: "var(--font-sans)",
        mono: "var(--font-mono)",
      },
      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
        overshoot: "cubic-bezier(0.34, 1.3, 0.64, 1)",
        decel: "cubic-bezier(0.165, 0.84, 0.44, 1)",
        press: "cubic-bezier(0.32, 0.72, 0, 1)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "none" },
        },
        "pop-in": {
          "0%": { opacity: "0", transform: "scale(0.96) translateY(4px)" },
          "100%": { opacity: "1", transform: "none" },
        },
        "pop-out": {
          "0%": { opacity: "1", transform: "none" },
          "100%": { opacity: "0", transform: "scale(0.97) translateY(2px)" },
        },
        "overlay-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "overlay-out": {
          "0%": { opacity: "1" },
          "100%": { opacity: "0" },
        },
        "quiet-dot": {
          "0%, 8%": { opacity: "0.2", transform: "translateY(2px)" },
          "22%": { opacity: "1", transform: "translateY(-2.5px)" },
          "36%, 70%": { opacity: "1", transform: "translateY(0)" },
          "90%, 100%": { opacity: "0.2", transform: "translateY(0)" },
        },
        breathe: {
          "0%, 100%": { filter: "brightness(0.96)", transform: "scale(0.92)" },
          "50%": { filter: "brightness(1.08)", transform: "scale(1.08)" },
        },
        "dot-pulse": {
          "0%, 100%": { opacity: "0.3", transform: "scale(0.85)" },
          "50%": { opacity: "1", transform: "scale(1.15)" },
        },
        "saved-check": {
          to: { opacity: "0", transform: "scale(0.94)" },
        },
        "stream-cursor": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.15" },
        },
        "skeleton-sweep": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-up": "fade-up 320ms var(--ease-out-expo) both",
        "pop-in": "pop-in 260ms var(--ease-overshoot) both",
        "pop-out": "pop-out 140ms var(--ease-press) both",
        "overlay-in": "overlay-in 200ms var(--ease-out-expo) both",
        "overlay-out": "overlay-out 140ms var(--ease-press) both",
        "quiet-dot": "quiet-dot 1.9s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        breathe: "breathe 2.4s ease-in-out infinite",
        "dot-pulse": "dot-pulse 1.2s ease-in-out infinite",
        "saved-check": "saved-check 350ms var(--ease-decel) 2.15s both",
        cursor: "stream-cursor 1.1s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
