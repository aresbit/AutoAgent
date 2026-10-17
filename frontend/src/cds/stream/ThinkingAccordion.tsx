import { AnimatePresence, motion } from "motion/react";
import { Brain, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { cx } from "@/lib/cx";
import { SPRING_REVEAL, useSpring } from "../motion/presets";
import { QuietDots } from "../atoms/Status";

export function ThinkingAccordion({
  text,
  streaming,
  className,
}: {
  text: string;
  streaming: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const transition = useSpring(SPRING_REVEAL);

  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  const expanded = streaming || open;

  return (
    <div className={cx("overflow-hidden rounded-card bg-panel-2", className)}>
      <button
        type="button"
        onClick={() => {
          if (!streaming) setOpen((value) => !value);
        }}
        aria-expanded={expanded}
        aria-disabled={streaming || undefined}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-ink-2 transition-colors duration-150 ease-out-expo hover:bg-hover focus-visible:outline-none focus-visible:shadow-focus"
      >
        <Brain size={13} strokeWidth={2} className="text-accent" aria-hidden />
        <span>Thinking</span>
        {streaming ? <QuietDots label="Thinking" /> : null}
        <motion.span
          className="ml-auto text-ink-3"
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={transition}
          aria-hidden
        >
          <ChevronDown size={13} strokeWidth={2} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
            className="overflow-hidden"
          >
            <div className="whitespace-pre-wrap px-3 pb-3 text-[12.5px] leading-relaxed text-ink-2">
              {text || <span className="text-ink-3">Working through the request…</span>}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
