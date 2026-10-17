import type { Transition } from "motion/react";
import { useReducedMotion } from "motion/react";

export const SPRING_PRESS: Transition = { type: "spring", stiffness: 600, damping: 30, mass: 1 };
export const SPRING_REVEAL: Transition = { type: "spring", stiffness: 320, damping: 28, mass: 1 };
export const SPRING_FEEDBACK: Transition = {
  type: "spring",
  stiffness: 380,
  damping: 18,
  mass: 1,
};
export const SPRING_SNAP: Transition = {
  type: "spring",
  stiffness: 1200,
  damping: 80,
  mass: 0.1,
};
export const SPRING_THUMB: Transition = { type: "spring", stiffness: 500, damping: 35 };

export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

export function useSpring(transition: Transition): Transition {
  const reduced = useReducedMotion();
  return reduced ? { duration: 0 } : transition;
}

export function isComposingEvent(e: {
  nativeEvent: KeyboardEvent;
  keyCode?: number;
}): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}
