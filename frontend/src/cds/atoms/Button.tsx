import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cx } from "@/lib/cx";

const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium transition-[background-color,color,box-shadow,transform,opacity] duration-150 ease-out-expo active:scale-[0.98] active:duration-75 focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        primary: "bg-accent text-on-accent hover:bg-accent-hover",
        secondary: "bg-panel text-ink shadow-panel hover:bg-hover",
        ghost: "text-ink-2 hover:bg-hover hover:text-ink",
        soft: "bg-panel-2 text-ink hover:bg-selected",
        danger: "bg-bad text-on-accent hover:opacity-90",
        link: "text-accent underline-offset-2 hover:underline",
      },
      size: {
        xs: "h-6 rounded-md px-2 text-[11.5px]",
        sm: "h-8 rounded-lg px-3 text-[13px]",
        md: "h-9 rounded-card px-4 text-sm",
        lg: "h-10 rounded-card px-5 text-sm",
        icon: "h-8 w-8 rounded-lg",
        "icon-sm": "h-7 w-7 rounded-md",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { loading?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cx(buttonVariants({ variant, size }), loading && "opacity-70", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {children}
    </button>
  ),
);
Button.displayName = "Button";

export { buttonVariants };
