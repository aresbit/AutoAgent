import { useCallback, useRef, useState, type KeyboardEvent } from "react";

export function nextIndex(
  key: string,
  index: number,
  count: number,
  orientation: "vertical" | "horizontal",
  loop = true,
): number | null {
  let target: number;
  switch (key) {
    case "ArrowDown":
      if (orientation !== "vertical") return null;
      target = index + 1;
      break;
    case "ArrowUp":
      if (orientation !== "vertical") return null;
      target = index - 1;
      break;
    case "ArrowRight":
      if (orientation !== "horizontal") return null;
      target = index + 1;
      break;
    case "ArrowLeft":
      if (orientation !== "horizontal") return null;
      target = index - 1;
      break;
    case "Home":
      target = 0;
      break;
    case "End":
      target = count - 1;
      break;
    default:
      return null;
  }
  if (count <= 0) return null;
  return loop
    ? (target + count) % count
    : Math.max(0, Math.min(count - 1, target));
}

export function useRovingFocus(
  count: number,
  orientation: "vertical" | "horizontal" = "vertical",
) {
  const [current, setCurrent] = useState(0);
  const items = useRef<(HTMLElement | null)[]>([]);
  const onKeyDown = useCallback(
    (event: KeyboardEvent, index: number) => {
      const target = nextIndex(event.key, index, count, orientation);
      if (target === null) return;
      event.preventDefault();
      setCurrent(target);
      items.current[target]?.focus({ preventScroll: false });
    },
    [count, orientation],
  );
  return {
    itemProps: (index: number) => ({
      ref: (el: HTMLElement | null) => {
        items.current[index] = el;
      },
      tabIndex: index === (count > 0 ? Math.min(current, count - 1) : 0) ? 0 : -1,
      onKeyDown: (event: KeyboardEvent) => onKeyDown(event, index),
      onFocus: () => setCurrent(index),
    }),
  };
}
