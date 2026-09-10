import "dotenv/config";
import type { Asset, Duration } from "@prisma/client";
import { prisma } from "../ledger/db";
import * as repo from "../ledger/repository";
import * as adapter from "../adapter/dreamdexClient";
import { computeModelProbability, MIN_OBSERVATIONS_THRESHOLD } from "../decision/calibrate";
import { computeEdge } from "../decision/edge";
import { sizePosition, wouldExceedDailyLimit } from "../decision/sizing";
import { isLowVolatilityChop } from "../decision/volatility";

const MIN_STT_BALANCE = 0.005; // enough to cover one order's gas on Shannon testnet

export type EvaluateResult =
  | {
      acted: false;
      reason:
        | "PREDICTION_EXISTS"
        | "KILL_SWITCH_ACTIVE"
        | "INSUFFICIENT_DATA"
        | "LOW_VOLATILITY_CHOP"
        | "EXCESSIVE_SPREAD"
        | "EDGE_BELOW_THRESHOLD"
        | "RISK_LIMIT_HIT"
        | "INSUFFICIENT_GAS";
      prediction: { id: string; modelPUp: number; marketPUp: number; edge: number; nObservations: number } | null;
      decision: { id: string; action: string; reason: string } | null;
      window: { exchangeWindowId: string; oracleQuestionId?: string | null } | null;
    }
  | {
      acted: true;
      reason: "EDGE_CLEARED";
      prediction: { id: string; modelPUp: number; marketPUp: number; edge: number; nObservations: number };
      decision: { id: string; action: string; reason: string; stake: number | null };
      order: { exchangeOrderId: string; side: string } | null;
      window: { exchangeWindowId: string; oracleQuestionId?: string | null };
    };

export async function evaluateAndAct(asset: Asset, duration: Duration): Promise<EvaluateResult> {
  // 1. Get current window from exchange (uses exchange's own timestamps, on-chain gated)
  const exWindow = await adapter.getCurrentWindow(asset, duration);

  // 2. Idempotency: check ledger BEFORE any other external call
  const existingWindow = await prisma.window.findUnique({
    where: { exchangeWindowId: exWindow.exchangeWindowId },
    include: { prediction: true },
  });
  if (existingWindow?.prediction) {
    return {
      acted: false,
      reason: "PREDICTION_EXISTS",
      prediction: {
        id: existingWindow.prediction.id,
        modelPUp: existingWindow.prediction.modelPUp,
        marketPUp: existingWindow.prediction.marketPUp,
        edge: existingWindow.prediction.edge,
        nObservations: existingWindow.prediction.nObservations,
      },
      decision: null,
      window: { exchangeWindowId: exWindow.exchangeWindowId, oracleQuestionId: existingWindow.oracleQuestionId },
    };
  }

  // Ensure window row exists (with oracleQuestionId for audit trail)
  const windowRow = await repo.saveWindow({
    asset: exWindow.asset,
    duration: exWindow.duration,
    openTs: exWindow.openTs,
    closeTs: exWindow.closeTs,
    exchangeWindowId: exWindow.exchangeWindowId,
    oracleQuestionId: exWindow.oracleQuestionId ?? null,
    status: "OPEN",
    source: "LIVE",
  });

  // 3. Fetch market odds + compute model probability
  const marketOdds = await adapter.getMarketOdds(exWindow);

  // Recent settled outcomes for this asset/duration — exclude voided (outcome null) per schema
  const liveSettlements = await prisma.settlement.findMany({
    where: { window: { asset, duration, source: "LIVE" }, voided: false, outcome: { not: null } },
    orderBy: { settledAt: "desc" },
    take: 100,
    select: { outcome: true },
  });
  const liveOutcomes = liveSettlements.map((s) => s.outcome).filter(Boolean) as ("UP" | "DOWN")[];

  // Warm-start empirical prior from BACKTEST data if live history is young
  // Prevents cold-start lockup while preserving statistical honesty
  let priorAlpha = 1;
  let priorBeta = 1;
  let totalObservations = liveOutcomes.length;

  if (liveOutcomes.length < MIN_OBSERVATIONS_THRESHOLD) {
    const backtestSettlements = await prisma.settlement.findMany({
      where: { window: { asset, duration, source: "BACKTEST" }, voided: false, outcome: { not: null } },
      take: 200,
      select: { outcome: true },
    });
    if (backtestSettlements.length >= MIN_OBSERVATIONS_THRESHOLD) {
      const upCount = backtestSettlements.filter((s) => s.outcome === "UP").length;
      const downCount = backtestSettlements.length - upCount;
      // Anchor prior with 10 pseudo-observations of empirical baseline
      const scale = 10 / backtestSettlements.length;
      priorAlpha = 1 + upCount * scale;
      priorBeta = 1 + downCount * scale;
      totalObservations += backtestSettlements.length;
    }
  }

  // Feature conditioning: Derive spot drift from market odds deviation from 50%
  const spotDrift = (marketOdds.pUp - 0.5) * 0.006;
  const model = computeModelProbability(liveOutcomes, priorAlpha, priorBeta, { spotDrift });
  const edge = computeEdge(model.pUp, marketOdds.pUp);

  // ALWAYS write Prediction, even if we skip
  const prediction = await repo.savePrediction({
    windowId: windowRow.id,
    modelPUp: model.pUp,
    marketPUp: marketOdds.pUp,
    edge,
    confidenceLow: model.confidenceLow,
    confidenceHigh: model.confidenceHigh,
    modelVersion: model.modelVersion,
    nObservations: totalObservations,
  });

  // 4. Fresh RiskLimits (never cached)
  const riskLimits = await repo.getRiskLimits();

  // 5. Decision cascade
  if (riskLimits.killSwitch) {
    const decision = await repo.saveDecision({
      predictionId: prediction.id,
      action: "SKIP",
      reason: "KILL_SWITCH_ACTIVE",
    });
    return {
      acted: false,
      reason: "KILL_SWITCH_ACTIVE",
      prediction: { id: prediction.id, modelPUp: model.pUp, marketPUp: marketOdds.pUp, edge, nObservations: totalObservations },
      decision: { id: decision.id, action: decision.action, reason: decision.reason },
      window: { exchangeWindowId: exWindow.exchangeWindowId, oracleQuestionId: exWindow.oracleQuestionId },
    };
  }

  if (totalObservations < MIN_OBSERVATIONS_THRESHOLD) {
    const decision = await repo.saveDecision({
      predictionId: prediction.id,
      action: "SKIP",
      reason: "INSUFFICIENT_DATA",
    });
    return {
      acted: false,
      reason: "INSUFFICIENT_DATA",
      prediction: { id: prediction.id, modelPUp: model.pUp, marketPUp: marketOdds.pUp, edge, nObservations: totalObservations },
      decision: { id: decision.id, action: decision.action, reason: decision.reason },
      window: { exchangeWindowId: exWindow.exchangeWindowId, oracleQuestionId: exWindow.oracleQuestionId },
    };
  }

  const spread = marketOdds.spread ?? (marketOdds.bestAsk != null && marketOdds.bestBid != null ? marketOdds.bestAsk - marketOdds.bestBid : 0.04);

  // Volatility chop filter (adopting Somnia-DreamDEX-Agent's strength): a market sitting
  // within a hair of 50/50 with a tight spread has no directional conviction — sit out
  // rather than pay the spread for a coinflip.
  if (isLowVolatilityChop({ marketPUp: marketOdds.pUp, spread })) {
    const decision = await repo.saveDecision({
      predictionId: prediction.id,
      action: "SKIP",
      reason: "LOW_VOLATILITY_CHOP",
    });
    return {
      acted: false,
      reason: "LOW_VOLATILITY_CHOP",
      prediction: { id: prediction.id, modelPUp: model.pUp, marketPUp: marketOdds.pUp, edge, nObservations: totalObservations },
      decision: { id: decision.id, action: decision.action, reason: decision.reason },
      window: { exchangeWindowId: exWindow.exchangeWindowId, oracleQuestionId: exWindow.oracleQuestionId },
    };
  }

  // Spread check: if orderbook is excessively wide (>15%), refuse to cross it
  if (spread > 0.15) {
    const decision = await repo.saveDecision({
      predictionId: prediction.id,
      action: "SKIP",
      reason: "EXCESSIVE_SPREAD",
    });
    return {
      acted: false,
      reason: "EXCESSIVE_SPREAD",
      prediction: { id: prediction.id, modelPUp: model.pUp, marketPUp: marketOdds.pUp, edge, nObservations: totalObservations },
      decision: { id: decision.id, action: decision.action, reason: decision.reason },
      window: { exchangeWindowId: exWindow.exchangeWindowId, oracleQuestionId: exWindow.oracleQuestionId },
    };
  }

  if (Math.abs(edge) < riskLimits.minEdgeThreshold) {
    const decision = await repo.saveDecision({
      predictionId: prediction.id,
      action: "SKIP",
      reason: "EDGE_BELOW_THRESHOLD",
    });
    return {
      acted: false,
      reason: "EDGE_BELOW_THRESHOLD",
      prediction: { id: prediction.id, modelPUp: model.pUp, marketPUp: marketOdds.pUp, edge, nObservations: totalObservations },
      decision: { id: decision.id, action: decision.action, reason: decision.reason },
      window: { exchangeWindowId: exWindow.exchangeWindowId, oracleQuestionId: exWindow.oracleQuestionId },
    };
  }

  // Sizing
  const sizing = sizePosition(edge, riskLimits);

  // Daily limit check — UTC midnight boundary + wallet balance check (per M2/M4)
  const now = new Date();
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const dailyTotal = await repo.getDailyStakeTotal(utcMidnight);
  if (wouldExceedDailyLimit(dailyTotal, sizing.stake, riskLimits)) {
    const decision = await repo.saveDecision({
      predictionId: prediction.id,
      action: "SKIP",
      reason: "RISK_LIMIT_HIT",
    });
    return {
      acted: false,
      reason: "RISK_LIMIT_HIT",
      prediction: { id: prediction.id, modelPUp: model.pUp, marketPUp: marketOdds.pUp, edge, nObservations: totalObservations },
      decision: { id: decision.id, action: decision.action, reason: decision.reason },
      window: { exchangeWindowId: exWindow.exchangeWindowId, oracleQuestionId: exWindow.oracleQuestionId },
    };
  }

  // Wallet balance check before signing — avoid a revert loop from spending gas on a tx
  // that can never land. Mock mode reports Infinity so the demo path is never blocked.
  const balance = await adapter.getWalletBalanceStt();
  if (balance < MIN_STT_BALANCE) {
    console.warn(`[orchestrator] insufficient STT balance (${balance}) — skipping tick`);
    const decision = await repo.saveDecision({
      predictionId: prediction.id,
      action: "SKIP",
      reason: "INSUFFICIENT_GAS",
    });
    return {
      acted: false,
      reason: "INSUFFICIENT_GAS",
      prediction: { id: prediction.id, modelPUp: model.pUp, marketPUp: marketOdds.pUp, edge, nObservations: totalObservations },
      decision: { id: decision.id, action: decision.action, reason: decision.reason },
      window: { exchangeWindowId: exWindow.exchangeWindowId, oracleQuestionId: exWindow.oracleQuestionId },
    };
  }

  // Trade — save decision first, then place order, then save order immediately
  const side = edge > 0 ? "UP" : "DOWN";
  const decision = await repo.saveDecision({
    predictionId: prediction.id,
    action: "TRADE",
    reason: "EDGE_CLEARED",
    stake: sizing.stake,
    kellyFraction: sizing.kellyFraction,
  });

  let order: { exchangeOrderId: string; side: string } | null = null;
  try {
    const result = await adapter.placeOrder(exWindow, side as "UP" | "DOWN", sizing.stake);
    // Write Order row immediately after exchange call — before any other logic
    await repo.saveOrder({
      decisionId: decision.id,
      exchangeOrderId: result.exchangeOrderId,
      side: side as "UP" | "DOWN",
      stake: sizing.stake,
    });
    order = { exchangeOrderId: result.exchangeOrderId, side };
  } catch (e) {
    console.error(`[orchestrator] placeOrder failed for ${exWindow.exchangeWindowId}:`, e);
  }

  return {
    acted: true,
    reason: "EDGE_CLEARED",
    prediction: { id: prediction.id, modelPUp: model.pUp, marketPUp: marketOdds.pUp, edge, nObservations: totalObservations },
    decision: { id: decision.id, action: decision.action, reason: decision.reason, stake: sizing.stake },
    order,
    window: { exchangeWindowId: exWindow.exchangeWindowId, oracleQuestionId: exWindow.oracleQuestionId },
  };
}
