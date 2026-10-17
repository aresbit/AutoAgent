import { useCallback, useEffect, useRef, useState } from "react";

const PIN_TOLERANCE = 40;
const JUMP_AFTER = 120;
const USER_COOLDOWN_MS = 150;

export function useScrollPinning(trigger: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const lastUser = useRef(0);
  const programmaticTarget = useRef<number | null>(null);

  const markUserInput = useCallback(() => {
    lastUser.current = performance.now();
    const el = ref.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom > PIN_TOLERANCE) setPinned(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (programmaticTarget.current !== null) {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const target = Math.min(programmaticTarget.current, max);
      programmaticTarget.current = null;
      if (Math.abs(el.scrollTop - target) <= 2) return;
    }
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(fromBottom <= PIN_TOLERANCE);
    setShowJump(fromBottom > JUMP_AFTER);
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = ref.current;
    if (!el) return;
    programmaticTarget.current = el.scrollHeight;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setPinned(true);
    setShowJump(false);
  }, []);

  const reset = useCallback(() => {
    programmaticTarget.current = null;
    lastUser.current = 0;
    setPinned(true);
    setShowJump(false);
  }, []);

  useEffect(() => {
    if (performance.now() - lastUser.current <= USER_COOLDOWN_MS) return;
    if (pinned) scrollToBottom(false);
  }, [trigger, pinned, scrollToBottom]);

  return { ref, pinned, showJump, onScroll, markUserInput, scrollToBottom, reset };
}
