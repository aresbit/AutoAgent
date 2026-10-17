import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "@/lib/cx";

export function CodeBlock({
  code,
  language = "text",
  className,
  maxHeight = 420,
}: {
  code: string;
  language?: string;
  className?: string;
  maxHeight?: number;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }, [code]);

  return (
    <div
      className={cx(
        "group overflow-hidden rounded-xl bg-code text-code-ink shadow-[inset_0_0_0_var(--hairline)_var(--code-line)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 shadow-[inset_0_calc(var(--hairline)*-1)_0_var(--code-line)]">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-code-muted">
          {language}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-code-muted transition-[color,background-color,transform] duration-150 ease-out-expo hover:bg-code-hover hover:text-code-ink focus-visible:outline-none focus-visible:shadow-focus active:scale-[0.98]"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? (
            <Check size={12} strokeWidth={2.4} className="text-ok animate-saved-check" />
          ) : (
            <Copy size={12} strokeWidth={2} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="scroll-area overflow-auto" style={{ maxHeight }}>
        <pre className="min-w-full p-3 text-[12px] leading-5">
          <code className="font-mono">{code}</code>
        </pre>
      </div>
    </div>
  );
}
