import { ArrowUp, Square } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { cx } from "@/lib/cx";
import { isComposingEvent } from "../motion/presets";
import { Button } from "../atoms/Button";

export function Composer({
  value,
  onChange,
  onSend,
  onCancel,
  streaming,
  cancelling = false,
  disabled,
  placeholder = "Send a message…",
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  streaming: boolean;
  cancelling?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 24), 200)}px`;
  }, [value]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
    [onChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposingEvent(event) || composing.current) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!streaming && !disabled && value.trim()) onSend();
      }
    },
    [disabled, onSend, streaming, value],
  );

  const canSend = !streaming && !disabled && value.trim().length > 0;

  return (
    <div className="px-3 pb-3 pt-2 sm:px-5 sm:pb-5">
      <div className="composer-surface rounded-composer px-3 pb-2 pt-2.5">
        <label htmlFor="composer-input" className="sr-only">
          Message
        </label>
        <textarea
          id="composer-input"
          ref={textarea}
          value={value}
          rows={1}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          placeholder={placeholder}
          disabled={disabled}
          className="block max-h-[200px] min-h-6 w-full resize-none bg-transparent px-1 py-1 text-[14px] leading-6 text-ink placeholder:text-ink-3 focus-visible:outline-none disabled:opacity-50 scroll-area"
          aria-describedby="composer-hint"
        />
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <p id="composer-hint" className="hidden text-[11px] text-ink-3 sm:block">
            Enter to send · Shift+Enter for a new line
          </p>
          <div className="ml-auto flex items-center gap-2">
            {streaming ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={onCancel}
                disabled={cancelling}
              >
                <Square size={11} strokeWidth={2.4} fill="currentColor" />
                {cancelling ? "Stopping" : "Stop"}
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="icon"
              onClick={onSend}
              disabled={!canSend}
              aria-label="Send message"
              className={cx("h-8 w-8 rounded-full", !canSend && "shadow-none")}
            >
              <ArrowUp size={15} strokeWidth={2.4} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
