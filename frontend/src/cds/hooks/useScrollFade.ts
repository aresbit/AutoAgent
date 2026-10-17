import { useCallback, useEffect, useRef } from "react";

const FADE = 28;

export function useScrollFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--fade-top", el.scrollTop <= 2 ? "0px" : `${FADE}px`);
    el.style.setProperty(
      "--fade-bottom",
      el.scrollTop + el.clientHeight >= el.scrollHeight - 2 ? "0px" : `${FADE}px`,
    );
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [update]);
  return ref;
}
