import { describe, expect, it } from "vitest";
import { backoffDelay } from "@/cds/hooks/useBackoff";
import { nextIndex } from "@/cds/hooks/useRovingFocus";
import { clampLayout, clampWidth } from "@/lib/layout";

describe("layout clamping", () => {
  it("clamps widths to their side limits", () => {
    expect(clampWidth(10, 220, 420)).toBe(220);
    expect(clampWidth(999, 220, 420)).toBe(420);
    expect(clampWidth(300.4, 220, 420)).toBe(300);
  });

  it("normalizes a persisted layout", () => {
    expect(
      clampLayout({
        leftOpen: true,
        rightOpen: false,
        leftWidth: 5,
        rightWidth: 900,
      }),
    ).toEqual({ leftOpen: true, rightOpen: false, leftWidth: 220, rightWidth: 480 });
  });
});

describe("roving focus", () => {
  it("wraps vertically and ignores the wrong axis", () => {
    expect(nextIndex("ArrowDown", 2, 3, "vertical")).toBe(0);
    expect(nextIndex("ArrowUp", 0, 3, "vertical")).toBe(2);
    expect(nextIndex("ArrowRight", 0, 3, "vertical")).toBeNull();
  });

  it("supports Home, End and non-looping lists", () => {
    expect(nextIndex("Home", 2, 4, "horizontal")).toBe(0);
    expect(nextIndex("End", 0, 4, "horizontal")).toBe(3);
    expect(nextIndex("ArrowRight", 3, 4, "horizontal", false)).toBe(3);
    expect(nextIndex("ArrowDown", 0, 0, "vertical")).toBeNull();
  });
});

describe("backoff", () => {
  it("doubles from five seconds and stops at ten minutes", () => {
    expect(backoffDelay(1)).toBe(5000);
    expect(backoffDelay(2)).toBe(10000);
    expect(backoffDelay(9)).toBe(600000);
  });

  it("respects Retry-After above the base", () => {
    expect(backoffDelay(1, 30)).toBe(30000);
    expect(backoffDelay(1, 1)).toBe(5000);
  });
});
