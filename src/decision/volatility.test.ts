import { describe, it, expect } from "vitest";
import { isLowVolatilityChop } from "./volatility";

describe("isLowVolatilityChop", () => {
  it("flags a dead-flat market with a tight spread", () => {
    expect(isLowVolatilityChop({ marketPUp: 0.502, spread: 0.02 })).toBe(true);
  });

  it("does not flag a market with real directional deviation", () => {
    expect(isLowVolatilityChop({ marketPUp: 0.62, spread: 0.02 })).toBe(false);
  });

  it("does not flag a flat market with a wide spread (illiquid, not quiet)", () => {
    expect(isLowVolatilityChop({ marketPUp: 0.5, spread: 0.1 })).toBe(false);
  });

  it("boundary — exactly at deviation threshold is not chop", () => {
    expect(isLowVolatilityChop({ marketPUp: 0.5 + 0.015, spread: 0.01 })).toBe(false);
  });
});
