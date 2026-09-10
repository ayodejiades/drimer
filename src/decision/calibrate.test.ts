import { describe, it, expect } from "vitest";
import { computeModelProbability, hasSufficientData, MODEL_VERSION } from "./calibrate";
import { computeEdge } from "./edge";
import { sizePosition } from "./sizing";

describe("calibrate — Beta-Binomial", () => {
  it("zero observations -> wide interval, prior-centered", () => {
    const r = computeModelProbability([]);
    expect(r.nObservations).toBe(0);
    expect(r.pUp).toBeCloseTo(0.5, 1);
    // 90% CI should be wide for n=0 (Beta(1,1) uniform)
    expect(r.confidenceLow).toBeLessThan(0.2);
    expect(r.confidenceHigh).toBeGreaterThan(0.8);
    expect(r.modelVersion).toBe(MODEL_VERSION);
    expect(hasSufficientData(r.nObservations)).toBe(false);
  });

  it("lopsided history 18 UP / 2 DOWN -> pUp pulled toward 0.9 but shrunk", () => {
    const outcomes = [...Array(18).fill("UP"), ...Array(2).fill("DOWN")] as ("UP" | "DOWN")[];
    const r = computeModelProbability(outcomes);
    expect(r.nObservations).toBe(20);
    // Posterior Beta(19,3): mean 19/22 ≈ 0.864, not 0.9
    expect(r.pUp).toBeCloseTo(19 / 22, 2);
    expect(r.pUp).toBeLessThan(0.9);
    expect(r.pUp).toBeGreaterThan(0.8);
    expect(hasSufficientData(r.nObservations)).toBe(true);
  });

  it("clips pUp strictly inside (0,1)", () => {
    const allUp = Array(100).fill("UP") as ("UP" | "DOWN")[];
    const r = computeModelProbability(allUp);
    expect(r.pUp).toBeLessThan(1);
    expect(r.pUp).toBeGreaterThan(0);
    expect(r.confidenceHigh).toBeLessThan(1);
    expect(r.confidenceLow).toBeGreaterThan(0);
  });

  it("computeEdge is centralized difference", () => {
    expect(computeEdge(0.6, 0.5)).toBeCloseTo(0.1);
    expect(computeEdge(0.4, 0.55)).toBeCloseTo(-0.15);
  });

  it("sizePosition never exceeds maxStakePerTrade even with huge edge", () => {
    const limits = { maxStakePerTrade: 5, maxDailyStake: 30, minEdgeThreshold: 0.05 };
    const r = sizePosition(0.99, limits); // absurd edge
    expect(r.stake).toBeLessThanOrEqual(5);
    expect(r.stake).toBeGreaterThan(0);
  });

  it("sizePosition returns 0 for zero edge", () => {
    const limits = { maxStakePerTrade: 5, maxDailyStake: 30, minEdgeThreshold: 0.05 };
    expect(sizePosition(0, limits).stake).toBe(0);
  });

  it("pure — no env or network needed", () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const r = computeModelProbability(["UP", "DOWN", "UP"] as ("UP" | "DOWN")[]);
    expect(r.nObservations).toBe(3);
    if (saved) process.env.DATABASE_URL = saved;
  });

  it("beta quantiles are ordered correctly", () => {
    const r = computeModelProbability(Array(10).fill("UP").concat(Array(10).fill("DOWN")) as ("UP" | "DOWN")[]);
    expect(r.confidenceLow).toBeLessThan(r.pUp);
    expect(r.pUp).toBeLessThan(r.confidenceHigh);
  });

  it("feature conditioning — positive drift adds UP evidence", () => {
    const base = computeModelProbability([]);
    const withPositiveDrift = computeModelProbability([], 1, 1, { spotDrift: 0.003 }); // +30 bps
    expect(withPositiveDrift.pUp).toBeGreaterThan(base.pUp);
    expect(withPositiveDrift.pUp).toBeGreaterThan(0.6);
    expect(withPositiveDrift.conditionedEvidence?.driftDeltaAlpha).toBeGreaterThan(0);
    expect(withPositiveDrift.conditionedEvidence?.driftDeltaBeta).toBe(0);
  });

  it("feature conditioning — negative drift adds DOWN evidence", () => {
    const base = computeModelProbability([]);
    const withNegativeDrift = computeModelProbability([], 1, 1, { spotDrift: -0.003 }); // -30 bps
    expect(withNegativeDrift.pUp).toBeLessThan(base.pUp);
    expect(withNegativeDrift.pUp).toBeLessThan(0.4);
    expect(withNegativeDrift.conditionedEvidence?.driftDeltaBeta).toBeGreaterThan(0);
  });

  it("calculates economic realization buckets and ROI", async () => {
    const { calculateEconomicRealization } = await import("./calibrate");
    const trades = [
      { edge: 0.08, stake: 5, side: "UP" as const, outcome: "UP" as const },
      { edge: 0.07, stake: 5, side: "UP" as const, outcome: "DOWN" as const },
      { edge: 0.15, stake: 10, side: "UP" as const, outcome: "UP" as const },
    ];
    const buckets = calculateEconomicRealization(trades);
    expect(buckets.length).toBe(4);
    const bucket5to10 = buckets.find((b) => b.edgeRange === "5% - 10%");
    expect(bucket5to10?.tradeCount).toBe(2);
    expect(bucket5to10?.winRate).toBe(0.5);
    const bucket10to20 = buckets.find((b) => b.edgeRange === "10% - 20%");
    expect(bucket10to20?.tradeCount).toBe(1);
    expect(bucket10to20?.winRate).toBe(1.0);
    expect(bucket10to20?.realizedRoi).toBeGreaterThan(0);
  });

  it("calculates benchmark comparison scores", async () => {
    const { calculateBenchmarkScores } = await import("./calibrate");
    const predictions = [
      { modelPUp: 0.7, marketPUp: 0.52, outcome: "UP" as const },
      { modelPUp: 0.3, marketPUp: 0.48, outcome: "DOWN" as const },
    ];
    const bench = calculateBenchmarkScores(predictions);
    expect(bench.drimerBrierScore).toBeLessThan(bench.marketImpliedBrierScore);
    expect(bench.drimerAdvantagePercent).toBeGreaterThan(0);
  });

  it("computes executable spread-aware edge correctly", async () => {
    const { computeExecutableEdge } = await import("./edge");
    // Model says 0.70 (strong UP). Best bid = 0.58, best ask = 0.62 (spread 0.04)
    const res = computeExecutableEdge(0.7, 0.58, 0.62);
    expect(res.direction).toBe("UP");
    expect(res.spread).toBeCloseTo(0.04);
    expect(res.executableEdge).toBeCloseTo(0.7 - 0.62); // 0.08
    expect(res.isExecutable).toBe(true);

    // Wide spread penalty
    const wideRes = computeExecutableEdge(0.7, 0.4, 0.65, 0.15); // spread 0.25 > 0.15
    expect(wideRes.isExecutable).toBe(false);
  });
});
