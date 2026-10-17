import { useCallback, useEffect, useRef, useState } from "react";

export const BACKOFF_BASE_MS = 5000;
export const BACKOFF_MAX_MS = 600000;
export const BACKOFF_ATTEMPTS = 3;

export function backoffDelay(
  attempt: number,
  retryAfterSeconds?: number,
  jitter = 1,
): number {
  const base = Math.max(
    retryAfterSeconds ? retryAfterSeconds * 1000 : BACKOFF_BASE_MS,
    BACKOFF_BASE_MS,
  );
  return Math.min(base * 2 ** (attempt - 1) * jitter, BACKOFF_MAX_MS);
}

export function useBackoff(retry: () => void) {
  const [attempt, setAttempt] = useState(0);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const trigger = useCallback((retryAfterSeconds?: number) => {
    setAttempt((current) => {
      const next = current + 1;
      if (next > BACKOFF_ATTEMPTS) {
        setRetryAt(null);
        return next;
      }
      const delay = backoffDelay(next, retryAfterSeconds, 0.85 + Math.random() * 0.3);
      setRetryAt(Date.now() + delay);
      setSecondsLeft(Math.ceil(delay / 1000));
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setAttempt(0);
    setRetryAt(null);
    setSecondsLeft(0);
  }, []);

  useEffect(() => {
    if (retryAt === null) return;
    timer.current = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) {
        setRetryAt(null);
        retry();
      }
    }, 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [retryAt, retry]);

  return {
    waiting: retryAt !== null,
    secondsLeft,
    exhausted: attempt > BACKOFF_ATTEMPTS,
    attempt,
    trigger,
    reset,
  };
}
