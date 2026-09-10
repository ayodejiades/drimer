import { NextResponse } from "next/server";
import { prisma } from "@/src/ledger/db";
import * as repo from "@/src/ledger/repository";
import * as adapter from "@/src/adapter/dreamdexClient";
import { computeModelProbability, MIN_OBSERVATIONS_THRESHOLD } from "@/src/decision/calibrate";
import { computeEdge } from "@/src/decision/edge";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    let riskLimits: Awaited<ReturnType<typeof repo.getRiskLimits>>;
    try {
      riskLimits = await repo.getRiskLimits();
    } catch (e) {
      console.warn("[api/market-view] DB unreachable, using defaults:", e);
      riskLimits = { id: 1, maxStakePerTrade: 5, maxDailyStake: 30, minEdgeThreshold: 0.05, killSwitch: false, updatedAt: new Date() };
    }

    // Try to get current window from adapter (mock fallback ok)
    let exWindow: Awaited<ReturnType<typeof adapter.getCurrentWindow>> | null = null;
    let marketPUp: number | null = null;
    try {
      exWindow = await adapter.getCurrentWindow("ETH", "FIFTEEN_MIN");
      const odds = await adapter.getMarketOdds(exWindow);
      marketPUp = odds.pUp;
    } catch (e) {
      console.warn("[api/market-view] adapter failed:", e);
    }

    // Recent outcomes for model
    let nObservations = 0;
    let modelPUp: number | null = null;
    let confidenceLow: number | null = null;
    let confidenceHigh: number | null = null;
    let modelVersion: string | null = null;
    try {
      const recent = await prisma.settlement.findMany({
        where: { window: { asset: "ETH", duration: "FIFTEEN_MIN", source: "LIVE" }, voided: false, outcome: { not: null } },
        orderBy: { settledAt: "desc" },
        take: 100,
        select: { outcome: true },
      });
      const liveOutcomes = recent.map((r) => r.outcome).filter(Boolean) as ("UP" | "DOWN")[];

      // Same empirical-Bayes warm-start the orchestrator uses (evaluateAndAct.ts) — otherwise
      // this "would trade now" preview understates readiness relative to what the bot actually does.
      let priorAlpha = 1;
      let priorBeta = 1;
      let totalObservations = liveOutcomes.length;
      if (liveOutcomes.length < MIN_OBSERVATIONS_THRESHOLD) {
        const backtestSettlements = await prisma.settlement.findMany({
          where: { window: { asset: "ETH", duration: "FIFTEEN_MIN", source: "BACKTEST" }, voided: false, outcome: { not: null } },
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
      }

      const spotDrift = marketPUp !== null ? (marketPUp - 0.5) * 0.006 : undefined;
      const model = computeModelProbability(liveOutcomes, priorAlpha, priorBeta, { spotDrift });
      nObservations = totalObservations;
      modelPUp = model.pUp;
      confidenceLow = model.confidenceLow;
      confidenceHigh = model.confidenceHigh;
      modelVersion = model.modelVersion;
    } catch (e) {
      console.warn("[api/market-view] model compute failed:", e);
    }

    // Check latest prediction for this window to derive wouldTradeNow/reason without double-computing
    let wouldTradeNow = false;
    let reason = "INSUFFICIENT_DATA";
    let edge: number | null = null;
    if (modelPUp !== null && marketPUp !== null) {
      edge = computeEdge(modelPUp, marketPUp);
      if (riskLimits.killSwitch) reason = "KILL_SWITCH_ACTIVE";
      else if (nObservations < 20) reason = "INSUFFICIENT_DATA";
      else if (Math.abs(edge) < riskLimits.minEdgeThreshold) reason = "EDGE_BELOW_THRESHOLD";
      else {
        // Check daily limit quickly
        const now = new Date();
        const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const dailyTotal = await repo.getDailyStakeTotal(utcMidnight).catch(() => 0);
        const { wouldExceedDailyLimit } = await import("@/src/decision/sizing");
        const { sizePosition } = await import("@/src/decision/sizing");
        const sizing = sizePosition(edge, riskLimits);
        if (wouldExceedDailyLimit(dailyTotal, sizing.stake, riskLimits)) reason = "RISK_LIMIT_HIT";
        else {
          reason = "EDGE_CLEARED";
          wouldTradeNow = true;
        }
      }
    } else {
      // No model yet
      reason = nObservations < 20 ? "INSUFFICIENT_DATA" : "EDGE_BELOW_THRESHOLD";
    }

    // If no window from adapter, synthesize one from last DB window or mock
    let windowPayload: Record<string, unknown> | null = null;
    if (exWindow) {
      windowPayload = {
        exchangeWindowId: exWindow.exchangeWindowId,
        oracleQuestionId: exWindow.oracleQuestionId ?? null,
        oracleAuditUrl: exWindow.oracleQuestionId ? `https://prd.oracle.somnia.host/questions/${exWindow.oracleQuestionId}?view=graph` : null,
        asset: exWindow.asset,
        duration: exWindow.duration,
        openTs: exWindow.openTs.toISOString(),
        closeTs: exWindow.closeTs.toISOString(),
        source: "LIVE",
      };
    } else {
      try {
        const lastWindow = await prisma.window.findFirst({ orderBy: { openTs: "desc" } });
        if (lastWindow) {
          windowPayload = {
            exchangeWindowId: lastWindow.exchangeWindowId,
            oracleQuestionId: (lastWindow as unknown as { oracleQuestionId?: string | null }).oracleQuestionId ?? null,
            oracleAuditUrl: (lastWindow as unknown as { oracleQuestionId?: string | null }).oracleQuestionId
              ? `https://prd.oracle.somnia.host/questions/${(lastWindow as unknown as { oracleQuestionId?: string | null }).oracleQuestionId}?view=graph`
              : null,
            asset: lastWindow.asset,
            duration: lastWindow.duration,
            openTs: lastWindow.openTs.toISOString(),
            closeTs: lastWindow.closeTs.toISOString(),
            source: lastWindow.source,
          };
        }
      } catch {}
    }

    // Empty state: if no settlements and no predictions, signal gathering
    let predCount = 0;
    try {
      predCount = await prisma.prediction.count();
    } catch {}
    const shouldShowEmpty = nObservations === 0 && predCount === 0;

    return NextResponse.json({
      window: windowPayload,
      modelPUp: shouldShowEmpty ? null : modelPUp,
      marketPUp: shouldShowEmpty ? null : marketPUp,
      edge: shouldShowEmpty ? null : edge,
      confidenceLow: shouldShowEmpty ? null : confidenceLow,
      confidenceHigh: shouldShowEmpty ? null : confidenceHigh,
      nObservations,
      modelVersion,
      riskLimits: {
        maxStakePerTrade: riskLimits.maxStakePerTrade,
        maxDailyStake: riskLimits.maxDailyStake,
        minEdgeThreshold: riskLimits.minEdgeThreshold,
        killSwitch: riskLimits.killSwitch,
      },
      wouldTradeNow,
      reason,
      asOf: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[api/market-view] error:", e);
    // Return empty-state payload instead of 500 so dashboard still renders
    return NextResponse.json({
      window: null,
      modelPUp: null,
      marketPUp: null,
      edge: null,
      confidenceLow: null,
      confidenceHigh: null,
      nObservations: 0,
      modelVersion: null,
      riskLimits: { maxStakePerTrade: 5, maxDailyStake: 30, minEdgeThreshold: 0.05, killSwitch: false },
      wouldTradeNow: false,
      reason: "INSUFFICIENT_DATA",
      asOf: new Date().toISOString(),
      _error: String(e),
    });
  }
}
