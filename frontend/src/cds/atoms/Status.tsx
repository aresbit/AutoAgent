import { Check, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export type Tone = "ok" | "warn" | "bad" | "info" | "accent" | "neutral";

const toneClass: Record<Tone, string> = {
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/10 text-warn",
  bad: "bg-bad/10 text-bad",
  info: "bg-info/10 text-info",
  accent: "bg-accent-soft text-accent",
  neutral: "bg-panel-2 text-ink-2",
};

export function Badge({
  children,
  tone = "neutral",
  className,
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-px text-[11.5px] font-medium leading-5",
        toneClass[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function QuietDots({ label = "Working" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1" role="status" aria-label={label}>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="h-1.5 w-1.5 rounded-full bg-ink-3 animate-quiet-dot"
          style={{ animationDelay: `${index * 140}ms` }}
        />
      ))}
    </span>
  );
}

export function BreathingDot({ tone = "accent" }: { tone?: Tone }) {
  return (
    <span
      className={cx(
        "inline-block h-2 w-2 rounded-full animate-breathe",
        tone === "accent"
          ? "bg-accent"
          : tone === "ok"
            ? "bg-ok"
            : tone === "bad"
              ? "bg-bad"
              : "bg-ink-3",
      )}
      aria-hidden
    />
  );
}

export function StreamingCursor() {
  return (
    <span
      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] rounded-full bg-accent animate-cursor"
      aria-hidden
    />
  );
}

export function SaveCheck({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-ok animate-saved-check">
      <Check size={13} strokeWidth={2.2} />
      Saved
    </span>
  );
}

export function ToolStatus({ ok }: { ok: boolean | null }) {
  if (ok === null) return <LoaderCircle size={13} className="text-info animate-quiet-dot" />;
  return ok ? (
    <Check size={13} strokeWidth={2.4} className="text-ok" />
  ) : (
    <X size={13} strokeWidth={2.4} className="text-bad" />
  );
}
