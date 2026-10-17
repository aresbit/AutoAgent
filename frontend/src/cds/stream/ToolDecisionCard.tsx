import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Terminal } from "lucide-react";
import { useState } from "react";
import type { LiveTool } from "@/api/types";
import { cx } from "@/lib/cx";
import { CodeBlock } from "../artifacts/CodeBlock";
import { SPRING_REVEAL, useSpring } from "../motion/presets";
import { Badge, QuietDots } from "../atoms/Status";

export function ToolDecisionCard({ tool, className }: { tool: LiveTool; className?: string }) {
  const [open, setOpen] = useState(false);
  const transition = useSpring(SPRING_REVEAL);
  const hasDetails = Boolean(tool.input) || Boolean(tool.result);

  return (
    <div className={cx("overflow-hidden rounded-card bg-panel-2", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        disabled={!hasDetails}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-150 ease-out-expo hover:bg-hover disabled:cursor-default focus-visible:outline-none focus-visible:shadow-focus"
      >
        <Terminal size={13} strokeWidth={2} className="text-ink-3" aria-hidden />
        <span className="text-[12px] font-medium text-ink-2">
          {tool.name ?? "Tool"}
        </span>
        <span className="t-code truncate text-[10.5px] text-ink-3">
          {tool.ref.slice(0, 8)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {tool.status === "running" ? (
            <Badge tone="info">
              <QuietDots label="Tool running" />
              Running
            </Badge>
          ) : tool.status === "ok" ? (
            <Badge tone="ok" dot>
              Done
            </Badge>
          ) : (
            <Badge tone="bad" dot>
              Failed
            </Badge>
          )}
          {hasDetails ? (
            <motion.span
              animate={{ rotate: open ? 180 : 0 }}
              transition={transition}
              className="text-ink-3"
              aria-hidden
            >
              <ChevronDown size={13} strokeWidth={2} />
            </motion.span>
          ) : null}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && hasDetails ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2 px-3 pb-3">
              {tool.input ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-3">
                    Input
                  </span>
                  <pre className="scroll-area max-h-48 overflow-auto rounded-lg bg-panel p-2 text-[11.5px] leading-5 text-ink-2 shadow-panel">
                    <code className="font-mono">{JSON.stringify(tool.input, null, 2)}</code>
                  </pre>
                </div>
              ) : null}
              {tool.result ? (
                <CodeBlock code={tool.result} language="output" maxHeight={220} />
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
