import { z } from "zod";
import { prisma } from "../../ledger/db";
import * as repo from "../../ledger/repository";
import * as adapter from "../../adapter/dreamdexClient";
import { computeModelProbability, MIN_OBSERVATIONS_THRESHOLD } from "../../decision/calibrate";
import { computeExecutableEdge } from "../../decision/edge";
import { sizePosition } from "../../decision/sizing";

export const name = "audit_and_calibrate_signal";
export const description =
  "Calibration Oracle for autonomous agents: audits an external prediction or trading signal against Drimer's empirical Bayesian settlement history. Returns the calibrated probability, spread-adjusted executable edge, Kelly-sized recommended stake, and a formal risk verdict (APPROVED, OVERCONFIDENT_DOWNSIZE, REJECT_NEGATIVE_EDGE, EXCESSIVE_SPREAD).";

export const inputSchema = z.object({
  asset: z.enum(["BTC", "ETH"]).describe("Asset of the event contract — BTC or ETH"),
  rawProbabilityUp: z
    .number()
    .min(0.01)
    .max(0.99)
    .describe("The external agent's claimed probability of UP outcome (0.01 to 0.99)"),
  intendedStake: z
    .number()
    .positive()
    .optional()
    .describe("The external agent's proposed stake in USDso (optional)"),
  duration: z
    .enum(["FIFTEEN_MIN", "ONE_HOUR"])
    .optional()
    .default("FIFTEEN_MIN")
    .describe("Window duration (default: FIFTEEN_MIN)"),
});

export async function handler(input: z.infer<typeof inputSchema>) {
  const asset = input.asset as "BTC" | "ETH";
  const duration = (input.duration ?? "FIFTEEN_MIN") as "FIFTEEN_MIN" | "ONE_HOUR";
  const rawP = input.rawProbabilityUp;

  let riskLimits: Awaited<ReturnType<typeof repo.getRiskLimits>>;
  try {
    riskLimits = await repo.getRiskLimits();
  } catch {
    riskLimits = {
      id: 1,
      maxStakePerTrade: 5,
      maxDailyStake: 30,
      minEdgeThreshold: 0.05,
      killSwitch: false,
      updatedAt: new Date(),
    } as Awaited<ReturnType<typeof repo.getRiskLimits>>;
  }

  // 1. Fetch live window and market odds
  let exWindow: Awaited<ReturnType<typeof adapter.getCurrentWindow>> | null = null;
  let marketOdds: Awaited<ReturnType<typeof adapter.getMarketOdds>> | null = null;
  try {
    exWindow = await adapter.getCurrentWindow(asset, duration);
    marketOdds = await adapter.getMarketOdds(exWindow);
  } catch (e) {
    return {
      error: `Failed to fetch exchange market odds: ${String(e)}`,
      asOf: new Date().toISOString(),
    };
  }

  const marketPUp = marketOdds.pUp;
  const bestBid = marketOdds.bestBid ?? Math.max(0.01, marketPUp - 0.02);
  const bestAsk = marketOdds.bestAsk ?? Math.min(0.99, marketPUp + 0.02);
  const spread = marketOdds.spread ?? (bestAsk - bestBid);

  // 2. Query historical settlements to build calibrated empirical prior
  let liveSettlements: { outcome: import("@prisma/client").Direction | null }[] = [];
  try {
    liveSettlements = await prisma.settlement.findMany({
      where: { window: { asset, duration, source: "LIVE" }, voided: false, outcome: { not: null } } as unknown as Record<string, unknown>,
      orderBy: { settledAt: "desc" },
      take: 100,
      select: { outcome: true },
    });
  } catch {
    liveSettlements = [];
  }

  const liveOutcomes = liveSettlements.map((s) => s.outcome).filter(Boolean) as ("UP" | "DOWN")[];
  let priorAlpha = 1;
  let priorBeta = 1;
  let totalObservations = liveOutcomes.length;

  if (liveOutcomes.length < MIN_OBSERVATIONS_THRESHOLD) {
    try {
      const backtestSettlements = await prisma.settlement.findMany({
        where: { window: { asset, duration, source: "BACKTEST" }, voided: false, outcome: { not: null } } as unknown as Record<string, unknown>,
        take: 200,
        select: { outcome: true },
      });
      if (backtestSettlements.length >= MIN_OBSERVATIONS_THRESHOLD) {
        const upCount = backtestSettlements.filter((s) => s.outcome === "UP").length;
        const downCount = backtestSettlements.length - upCount;
        const scale = 10 / backtestSettlements.length;
        priorAlpha = 1 + upCount * scale;
        priorBeta = 1 + downCount * scale;
        totalObservations += backtestSettlements.length;
      }
    } catch {
      // ignore
    }
  }

  // 3. Bayesian shrinkage of the external agent's signal
  // External models often suffer from overconfidence. We blend the raw signal with the empirical base-rate.
  const shrinkageWeight = Math.min(0.8, Math.max(0.3, totalObservations / 100));
  const baseCalibrated = computeModelProbability(liveOutcomes, priorAlpha, priorBeta);
  const calibratedPUp = Math.round((rawP * (1 - shrinkageWeight) + baseCalibrated.pUp * shrinkageWeight) * 1000) / 1000;

  // 4. Executable edge & spread analysis
  const edgeAnalysis = computeExecutableEdge(calibratedPUp, bestBid, bestAsk, 0.15);
  const rawEdge = Math.round((calibratedPUp - marketPUp) * 1000) / 1000;

  // 5. Position sizing via Fractional Kelly
  const sizing = sizePosition(rawEdge, riskLimits);
  let recommendedStake = sizing.stake;
  if (input.intendedStake != null) {
    recommendedStake = Math.min(input.intendedStake, sizing.stake);
  }

  // 6. Risk Verdict
  type Verdict = "APPROVED" | "OVERCONFIDENT_DOWNSIZE" | "REJECT_NEGATIVE_EDGE" | "EXCESSIVE_SPREAD" | "KILL_SWITCH_ACTIVE";
  let riskVerdict: Verdict = "APPROVED";

  if (riskLimits.killSwitch) {
    riskVerdict = "KILL_SWITCH_ACTIVE";
    recommendedStake = 0;
  } else if (spread > 0.15) {
    riskVerdict = "EXCESSIVE_SPREAD";
    recommendedStake = 0;
  } else if (edgeAnalysis.executableEdge <= 0 || Math.abs(rawEdge) < riskLimits.minEdgeThreshold) {
    riskVerdict = "REJECT_NEGATIVE_EDGE";
    recommendedStake = 0;
  } else if (Math.abs(rawP - calibratedPUp) > 0.1) {
    riskVerdict = "OVERCONFIDENT_DOWNSIZE";
  }

  return {
    asset,
    duration,
    rawClaimedProbability: rawP,
    calibratedProbabilityUp: calibratedPUp,
    marketOdds: {
      midpoint: marketPUp,
      bestBid,
      bestAsk,
      spread: Math.round(spread * 1000) / 1000,
    },
    edgeAnalysis: {
      rawEdge,
      executableEdge: Math.round(edgeAnalysis.executableEdge * 1000) / 1000,
      direction: edgeAnalysis.direction,
      isExecutable: edgeAnalysis.isExecutable,
    },
    sizing: {
      recommendedStake,
      kellyFraction: sizing.kellyFraction,
      maxAllowedStake: riskLimits.maxStakePerTrade,
    },
    riskVerdict,
    confidenceInterval: {
      low: baseCalibrated.confidenceLow,
      high: baseCalibrated.confidenceHigh,
    },
    observationsCount: totalObservations,
    oracleAuditUrl: exWindow?.oracleQuestionId
      ? `https://prd.oracle.somnia.host/questions/${exWindow.oracleQuestionId}?view=graph`
      : null,
    modelVersion: baseCalibrated.modelVersion,
    asOf: new Date().toISOString(),
  };
}
