import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Button } from "./Button";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 460,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50 bg-scrim data-[state=closed]:pointer-events-none" />
        <DialogPrimitive.Content
          className={cx(
            "dialog-content fixed left-1/2 top-1/2 z-50 max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-dialog bg-popover p-5 shadow-popover data-[state=closed]:pointer-events-none",
          )}
          style={{ width: `min(92vw, ${width}px)` }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <DialogPrimitive.Title className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-[12.5px] leading-relaxed text-ink-2">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close dialog"
                className="-mr-1 -mt-1 shrink-0"
              >
                <X size={15} strokeWidth={2} />
              </Button>
            </DialogPrimitive.Close>
          </div>
          {children ? <div className="mt-4">{children}</div> : null}
          {footer ? <div className="mt-5 flex items-center justify-end gap-2">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
