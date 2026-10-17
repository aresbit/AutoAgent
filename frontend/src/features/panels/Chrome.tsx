import { AlertTriangle, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/cds";
import { cx } from "@/lib/cx";

export function PanelHeader({
  icon,
  title,
  meta,
  actions,
  className,
}: {
  icon?: ReactNode;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex min-h-11 flex-none items-center gap-2 px-4 py-2.5", className)}>
      {icon ? <span className="text-ink-3">{icon}</span> : null}
      <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      {meta ? <span className="t-num text-[11.5px] text-ink-3">{meta}</span> : null}
      {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export function InlineError({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-bad/10 px-2.5 py-2 text-[11.5px] leading-relaxed text-bad"
    >
      <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 flex-none" aria-hidden />
      <span className="min-w-0 flex-1">{message}</span>
      {onDismiss ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="-my-1 -mr-1 h-6 w-6 flex-none text-bad hover:bg-bad/10 hover:text-bad"
          aria-label="Dismiss error"
          onClick={onDismiss}
        >
          <X size={12} strokeWidth={2} />
        </Button>
      ) : null}
    </div>
  );
}

export function PanelScroll({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("scroll-area min-h-0 flex-1 overflow-y-auto px-3 py-3", className)}>
      {children}
    </div>
  );
}
