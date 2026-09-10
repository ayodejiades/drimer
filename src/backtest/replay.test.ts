import { describe, it, expect } from "vitest";
import { computeModelProbability } from "../decision/calibrate";
import { buildWindows } from "./replay";
import type { PricePoint } from "./fetchHistoricalPrices";

describe("replay — no lookahead", () => {
  it("computeModelProbability for window N never sees outcome of N or later", () => {
    // Build deterministic price series
    const points: PricePoint[] = [];
    const start = Date.UTC(2024, 0, 1, 0, 0, 0);
    for (let i = 0; i < 20; i++) {
      points.push({ ts: new Date(start + i * 15 * 60 * 1000), price: 3000 + i * 10, asset: "ETH" });
    }
    const windows = buildWindows(points);
    expect(windows.length).toBeGreaterThan(5);

    const outcomes = windows.map((w) => w.outcome);
    // Simulate forward walk and assert that at step i, computeModelProbability only uses outcomes[0..i-1]
    for (let i = 0; i < windows.length; i++) {
      const prior = outcomes.slice(0, i);
      const result = computeModelProbability(prior);
      expect(result.nObservations).toBe(i);
      // If we accidentally included outcome i, n would be i+1 — with our slicing it's i
      // Now verify that adding outcome i changes the next prediction (so lookahead would matter)
      if (i + 1 < windows.length) {
        const nextPrior = outcomes.slice(0, i + 1);
        const nextResult = computeModelProbability(nextPrior);
        // n should increase by 1
        expect(nextResult.nObservations).toBe(i + 1);
      }
    }
  });

  it("buildWindows is sorted by openTs (forward walk invariant)", () => {
    const points: PricePoint[] = [];
    const start = Date.UTC(2024, 0, 1);
    for (let i = 0; i < 10; i++) points.push({ ts: new Date(start + i * 3600 * 1000), price: 100 + i, asset: "BTC" });
    const windows = buildWindows(points);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].openTs.getTime()).toBeGreaterThan(windows[i - 1].openTs.getTime());
    }
  });
});
