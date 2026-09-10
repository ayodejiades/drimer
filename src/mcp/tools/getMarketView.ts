import { z } from "zod";
import { prisma } from "../../ledger/db";
import * as repo from "../../ledger/repository";
import * as adapter from "../../adapter/dreamdexClient";
import { computeModelProbability } from "../../decision/calibrate";
import { computeEdge } from "../../decision/edge";

export const name = "get_market_view";
export const description =
  "Get the current market view for an asset (BTC or ETH). Returns the current tradeable window, market-implied probability vs model probability, edge, confidence interval, N observations, risk limits, and whether a trade would fire now with reason. One call — everything needed for a decision. Provenance (modelVersion, nObservations, asOf) is inline on every response.";

export const inputSchema = z.object({
  asset: z.enum(["BTC", "ETH"]).describe("Asset to get view for — BTC or ETH"),
  duration: z.enum(["FIFTEEN_MIN", "ONE_HOUR"]).optional().default("FIFTEEN_MIN").describe("Window duration"),
});

export async function handler(input: z.infer<typeof inputSchema>) {
  const asset = input.asset as "BTC" | "ETH";
  const duration = (input.duration ?? "FIFTEEN_MIN") as "FIFTEEN_MIN" | "ONE_HOUR";

  let riskLimits: Awaited<ReturnType<typeof repo.getRiskLimits>>;
  try {
    riskLimits = await repo.getRiskLimits();
  } catch {
    riskLimits = { id: 1, maxStakePerTrade: 5, maxDailyStake: 30, minEdgeThreshold: 0.05, killSwitch: false, updatedAt: new Date() } as Awaited<ReturnType<typeof repo.getRiskLimits>>;
  }

  let exWindow: Awaited<ReturnType<typeof adapter.getCurrentWindow>> | null = null;
  let marketPUp: number | null = null;
  try {
    exWindow = await adapter.getCurrentWindow(asset, duration);
    const odds = await adapter.getMarketOdds(exWindow);
    marketPUp = odds.pUp;
  } catch (e) {
    // return error structured
    return {
      error: `Failed to fetch market window/odds: ${String(e)}`,
      asOf: new Date().toISOString(),
    };
  }

  let recent: { outcome: import("@prisma/client").Direction | null }[] = [];
  try {
    recent = await prisma.settlement.findMany({
      where: { window: { asset, duration: duration as "FIFTEEN_MIN" | "ONE_HOUR", source: "LIVE" }, voided: false, outcome: { not: null } } as unknown as Record<string, unknown>,
      orderBy: { settledAt: "desc" },
      take: 100,
      select: { outcome: true },
    });
  } catch {
    recent = [];
  }
  const outcomes = recent.map((r) => r.outcome).filter(Boolean) as ("UP" | "DOWN")[];
  const model = computeModelProbability(outcomes as ("UP" | "DOWN")[]);
  const edge = marketPUp !== null ? computeEdge(model.pUp, marketPUp) : null;

  let wouldTradeNow = false;
  let reason: string = "INSUFFICIENT_DATA";
  if (edge !== null) {
    if (riskLimits.killSwitch) reason = "KILL_SWITCH_ACTIVE";
    else if (model.nObservations < 20) reason = "INSUFFICIENT_DATA";
    else if (Math.abs(edge) < riskLimits.minEdgeThreshold) reason = "EDGE_BELOW_THRESHOLD";
    else {
      const now = new Date();
      const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const dailyTotal = await repo.getDailyStakeTotal(utcMidnight).catch(() => 0);
      const { wouldExceedDailyLimit, sizePosition } = await import("../../decision/sizing");
      const sizing = sizePosition(edge, riskLimits);
      if (wouldExceedDailyLimit(dailyTotal, sizing.stake, riskLimits)) reason = "RISK_LIMIT_HIT";
      else {
        reason = "EDGE_CLEARED";
        wouldTradeNow = true;
      }
    }
  }

  return {
    window: exWindow
      ? {
          exchangeWindowId: exWindow.exchangeWindowId,
          oracleQuestionId: exWindow.oracleQuestionId ?? null,
          oracleAuditUrl: exWindow.oracleQuestionId ? `https://prd.oracle.somnia.host/questions/${exWindow.oracleQuestionId}?view=graph` : null,
          asset: exWindow.asset,
          duration: exWindow.duration,
          openTs: exWindow.openTs.toISOString(),
          closeTs: exWindow.closeTs.toISOString(),
        }
      : null,
    modelPUp: model.pUp,
    marketPUp,
    edge,
    confidenceInterval: { low: model.confidenceLow, high: model.confidenceHigh },
    nObservations: model.nObservations,
    modelVersion: model.modelVersion,
    riskLimits: {
      maxStakePerTrade: riskLimits.maxStakePerTrade,
      maxDailyStake: riskLimits.maxDailyStake,
      minEdgeThreshold: riskLimits.minEdgeThreshold,
      killSwitch: riskLimits.killSwitch,
    },
    wouldTradeNow,
    reason,
    asOf: new Date().toISOString(),
  };
}
