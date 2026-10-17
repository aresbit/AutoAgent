import { ChevronDown } from "lucide-react";
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cx } from "@/lib/cx";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[12px] font-medium text-ink-2">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[11.5px] text-bad" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[11.5px] leading-relaxed text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cx(
        "control h-9 w-full rounded-lg px-3 text-[13px] text-ink placeholder:text-ink-3 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cx(
      "control min-h-[72px] w-full resize-y rounded-lg px-3 py-2 text-[13px] leading-6 text-ink placeholder:text-ink-3 disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <span className="relative block">
    <select
      ref={ref}
      className={cx(
        "control h-9 w-full cursor-pointer appearance-none rounded-lg pl-3 pr-8 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      size={14}
      strokeWidth={2}
      className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3"
      aria-hidden
    />
  </span>
));
Select.displayName = "Select";
