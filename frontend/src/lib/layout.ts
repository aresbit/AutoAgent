import type { LayoutView } from "@/api/types";

export const DEFAULT_LEFT = 288;
export const DEFAULT_RIGHT = 360;
export const MIN_LEFT = 220;
export const MAX_LEFT = 420;
export const MIN_RIGHT = 280;
export const MAX_RIGHT = 480;

export function clampWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(width)));
}

export function clampLayout(layout: LayoutView): LayoutView {
  return {
    leftOpen: layout.leftOpen,
    rightOpen: layout.rightOpen,
    leftWidth: clampWidth(layout.leftWidth, MIN_LEFT, MAX_LEFT),
    rightWidth: clampWidth(layout.rightWidth, MIN_RIGHT, MAX_RIGHT),
  };
}

export function keyboardStep(viewportWidth: number): number {
  return Math.max(8, Math.round(viewportWidth * 0.03));
}
