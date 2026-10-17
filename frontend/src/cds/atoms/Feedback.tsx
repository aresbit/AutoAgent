import { AlertTriangle, Inbox, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Button } from "./Button";

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-card bg-panel-2 text-ink-3">
        {icon ?? <Inbox size={19} strokeWidth={1.8} />}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="max-w-sm text-[12.5px] leading-relaxed text-ink-2">{description}</p>
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  retry,
  retrying,
  className,
}: {
  title?: string;
  message: string;
  retry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        className,
      )}
      role="alert"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-card bg-bad/10 text-bad">
        <AlertTriangle size={18} strokeWidth={1.9} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="max-w-md text-[12.5px] leading-relaxed text-ink-2">{message}</p>
      </div>
      {retry ? (
        <Button variant="secondary" size="sm" onClick={retry} loading={retrying}>
          <RotateCcw size={13} strokeWidth={2} />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cx("relative overflow-hidden rounded-lg bg-panel-2", className)}>
      <div className="absolute inset-0 animate-[skeleton-sweep_1.8s_cubic-bezier(0.4,0,0.2,1)_infinite] bg-[linear-gradient(90deg,transparent,var(--hover),transparent)]" />
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
      {children}
    </p>
  );
}
