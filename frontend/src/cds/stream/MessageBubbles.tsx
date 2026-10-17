import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { StreamingCursor } from "../atoms/Status";

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MessageBubble({
  role,
  time,
  children,
  streaming = false,
  className,
}: {
  role: "user" | "assistant" | "system" | "tool";
  time?: number;
  children: ReactNode;
  streaming?: boolean;
  className?: string;
}) {
  if (role === "system") {
    return (
      <div className={cx("flex justify-center px-4", className)}>
        <p className="max-w-[80%] rounded-full bg-panel-2 px-3 py-1 text-center text-[11.5px] leading-5 text-ink-2">
          {children}
        </p>
      </div>
    );
  }

  if (role === "user") {
    return (
      <article
        className={cx("flex flex-col items-end gap-1 px-4 animate-fade-up", className)}
        aria-label="You"
      >
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[18px] bg-accent-soft px-4 py-2.5 text-[14px] leading-6 text-ink">
          {children}
        </div>
        {time ? (
          <span className="t-num pr-1 text-[10.5px] text-ink-3">{formatTime(time)}</span>
        ) : null}
      </article>
    );
  }

  return (
    <article
      className={cx("flex flex-col gap-1.5 px-4 animate-fade-up", className)}
      aria-label="Assistant"
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">
          Assistant
        </span>
        {time ? (
          <span className="t-num text-[10.5px] text-ink-3">{formatTime(time)}</span>
        ) : null}
        {streaming ? <StreamingCursor /> : null}
      </div>
      <div className="min-w-0 text-[14px] leading-[1.65] text-ink">{children}</div>
    </article>
  );
}
