import { NextResponse } from "next/server";
import { prisma } from "@/src/ledger/db";
import { calculateEconomicRealization, calculateBenchmarkScores, type TradeRecord } from "@/src/decision/calibrate";
import type { Direction } from "@prisma/client";

export const dynamic = "force-dynamic";

function brierScore(predictions: { p: number; outcome: number }[]): number | null {
  if (predictions.length === 0) return null;
  const sum = predictions.reduce((acc, { p, outcome }) => acc + Math.pow(p - outcome, 2), 0);
  return sum / predictions.length;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const source = url.searchParams.get("source") as "LIVE" | "BACKTEST" | null;

    // Fetch settled predictions joined to settlement — gracefully handle DB unreachable
    let settlements: any[] = [];
    let totalPredictions = 0;
    let decisions: any[] = [];
    let distinctVersions: { modelVersion: string }[] = [];
    try {
      settlements = await prisma.settlement.findMany({
      include: {
        window: {
          include: {
            prediction: true,
          },
        },
      },
      orderBy: { settledAt: "asc" },
      });
    } catch (e) {
      console.warn("[api/track-record] DB unreachable, returning empty:", e);
    }

    let filtered = settlements;
    if (source) filtered = settlements.filter((s) => (s as unknown as { window: { source: string } }).window.source === source);

    try {
      totalPredictions = await prisma.prediction.count(source ? { where: { window: { source: source as "LIVE" | "BACKTEST" } } } : undefined);
    } catch {}
    const totalSettled = filtered.length;

    // Brier score
    let brier: number | null = null;
    let modelVersion: string | null = null;
    const brierInputs: { p: number; outcome: number }[] = [];
    for (const s of filtered) {
      const pred = s.window.prediction;
      if (!pred) continue;
      if ((s as unknown as { voided?: boolean }).voided || s.outcome == null) continue; // voided has no winner — exclude from Brier/buckets
      brierInputs.push({ p: pred.modelPUp, outcome: s.outcome === "UP" ? 1 : 0 });
      if (!modelVersion) modelVersion = pred.modelVersion;
    }
    brier = brierScore(brierInputs);

    // Reliability buckets — deciles 0-0.1 ... 0.9-1.0
    type Bucket = {
      binLow: number;
      binHigh: number;
      binCenter: number;
      n: number;
      avgPredicted: number | null;
      observedFreq: number | null;
      source: "LIVE" | "BACKTEST" | "MIXED";
    };
    const buckets: Bucket[] = [];
    for (let i = 0; i < 10; i++) {
      const binLow = i / 10;
      const binHigh = (i + 1) / 10;
      const binCenter = (binLow + binHigh) / 2;
      const inBin = filtered.filter((s) => {
        if ((s as unknown as { voided?: boolean }).voided || s.outcome == null) return false;
        const p = s.window.prediction?.modelPUp;
        if (p === undefined || p === null) return false;
        // inclusive low, exclusive high except last
        if (i === 9) return p >= binLow && p <= binHigh;
        return p >= binLow && p < binHigh;
      });
      const n = inBin.length;
      let avgPredicted: number | null = null;
      let observedFreq: number | null = null;
      let bucketSource: "LIVE" | "BACKTEST" | "MIXED" = "LIVE";
      if (n > 0) {
        const preds = inBin.map((s) => s.window.prediction!.modelPUp);
        avgPredicted = preds.reduce((a, b) => a + b, 0) / n;
        const ups = inBin.filter((s) => s.outcome === "UP").length;
        observedFreq = ups / n;
        const sources = new Set(inBin.map((s) => s.window.source));
        if (sources.size > 1) bucketSource = "MIXED";
        else bucketSource = (Array.from(sources)[0] as "LIVE" | "BACKTEST") ?? "LIVE";
      }
      buckets.push({ binLow, binHigh, binCenter, n, avgPredicted, observedFreq, source: bucketSource });
    }

    // Recent decisions for log
    try {
      decisions = await prisma.decision.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          prediction: { include: { window: { include: { settlement: true } } } },
          order: true,
        },
      });
    } catch {}

    const decisionRows = decisions.map((d) => ({
      id: d.id,
      createdAt: d.createdAt.toISOString(),
      asset: d.prediction.window.asset,
      duration: d.prediction.window.duration,
      modelPUp: d.prediction.modelPUp,
      marketPUp: d.prediction.marketPUp,
      edge: d.prediction.edge,
      action: d.action,
      reason: d.reason,
      stake: d.stake,
      side: (d.order as unknown as { side?: string } | null)?.side ?? null,
      outcome: (d.prediction.window.settlement as unknown as { outcome?: string | null })?.outcome ?? null,
      voided: (d.prediction.window.settlement as unknown as { voided?: boolean })?.voided ?? false,
      source: d.prediction.window.source,
      exchangeWindowId: d.prediction.window.exchangeWindowId,
      oracleQuestionId: (d.prediction.window as unknown as { oracleQuestionId?: string | null }).oracleQuestionId ?? null,
      oracleAuditUrl: (d.prediction.window as unknown as { oracleQuestionId?: string | null }).oracleQuestionId
        ? `https://prd.oracle.somnia.host/questions/${(d.prediction.window as unknown as { oracleQuestionId?: string | null }).oracleQuestionId}?view=graph`
        : null,
    }));

    // Model version history — distinct versions
    try {
      distinctVersions = await prisma.prediction.findMany({
        distinct: ["modelVersion"],
        select: { modelVersion: true },
      });
    } catch {}

    // Economic realization — realized ROI by edge decile, disproving the "calibration doesn't equal P&L" thesis
    const tradeRecords: TradeRecord[] = decisionRows
      .filter((d): d is typeof d & { side: string; outcome: string } => d.action === "TRADE" && d.stake != null && !d.voided && d.side != null && d.outcome != null)
      .map((d) => ({ edge: d.edge, stake: d.stake as number, side: d.side as Direction, outcome: d.outcome as Direction }));
    const economicRealization = calculateEconomicRealization(tradeRecords);

    const benchmarkInputs = filtered
      .filter((s) => !(s as unknown as { voided?: boolean }).voided && s.outcome != null && s.window.prediction)
      .map((s) => ({
        modelPUp: s.window.prediction!.modelPUp,
        marketPUp: s.window.prediction!.marketPUp,
        outcome: s.outcome as Direction,
      }));
    const benchmarkScores = calculateBenchmarkScores(benchmarkInputs);

    return NextResponse.json({
      buckets,
      brierScore: brier,
      totalPredictions,
      totalSettled,
      modelVersion,
      modelVersionHistory: distinctVersions.map((v) => v.modelVersion),
      decisions: decisionRows,
      economicRealization,
      benchmarkScores,
      asOf: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[api/track-record] error:", e);
    // Return empty buckets instead of 500 so dashboard shows gathering state
    const emptyBuckets = Array.from({ length: 10 }, (_, i) => ({
      binLow: i / 10, binHigh: (i + 1) / 10, binCenter: (i + 0.5) / 10, n: 0, avgPredicted: null, observedFreq: null, source: "LIVE" as const,
    }));
    return NextResponse.json({
      buckets: emptyBuckets,
      brierScore: null,
      totalPredictions: 0,
      totalSettled: 0,
      modelVersion: null,
      modelVersionHistory: [],
      decisions: [],
      economicRealization: calculateEconomicRealization([]),
      benchmarkScores: calculateBenchmarkScores([]),
      asOf: new Date().toISOString(),
      _error: String(e),
    });
  }
}
