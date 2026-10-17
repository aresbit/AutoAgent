import * as TabsPrimitive from "@radix-ui/react-tabs";
import { motion } from "motion/react";
import { createContext, useContext, useId, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { SPRING_THUMB, useSpring } from "../motion/presets";

const ValueContext = createContext<string>("");

export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ValueContext.Provider value={value}>
      <TabsPrimitive.Root
        value={value}
        onValueChange={onValueChange}
        className={className}
      >
        {children}
      </TabsPrimitive.Root>
    </ValueContext.Provider>
  );
}

const ListContext = createContext<string | null>(null);

export function TabsList({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const layoutId = useId();
  return (
    <ListContext.Provider value={layoutId}>
      <TabsPrimitive.List
        aria-label={label}
        className={cx(
          "inline-flex items-center rounded-full bg-[var(--segmented-track)] p-0.5",
          className,
        )}
      >
        {children}
      </TabsPrimitive.List>
    </ListContext.Provider>
  );
}

export function TabsTrigger({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const active = useContext(ValueContext) === value;
  const layoutId = useContext(ListContext);
  const transition = useSpring(SPRING_THUMB);
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cx(
        "relative z-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium text-ink-3 transition-colors duration-150 ease-out-expo hover:text-ink-2 focus-visible:outline-none focus-visible:shadow-focus data-[state=active]:text-ink",
        className,
      )}
    >
      {active && layoutId ? (
        <motion.span
          layoutId={layoutId}
          transition={transition}
          className="absolute inset-0 -z-[1] rounded-full bg-[var(--segmented-thumb)] shadow-thumb"
        />
      ) : null}
      <span className="relative z-[1] inline-flex items-center gap-1.5">{children}</span>
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsPrimitive.Content
      value={value}
      className={cx("focus-visible:outline-none animate-fade-up", className)}
    >
      {children}
    </TabsPrimitive.Content>
  );
}
