import { z } from "zod";
import { prisma } from "../../ledger/db";

export const name = "get_track_record";
export const description =
  "Get the calibration track record — Brier score, reliability-diagram buckets, coverage (total predictions vs settled), and model version history. This is the self-critique surface: how has the model actually been doing? Provenance is inline. Optional since filter.";

export const inputSchema = z.object({
  since: z.string().optional().describe("ISO timestamp — only include settlements since this time"),
  source: z.enum(["LIVE", "BACKTEST"]).optional().describe("Filter by data source"),
});

function brier(predictions: { p: number; outcome: number }[]): number | null {
  if (predictions.length === 0) return null;
  return predictions.reduce((s, { p, outcome }) => s + Math.pow(p - outcome, 2), 0) / predictions.length;
}

export async function handler(input: z.infer<typeof inputSchema>) {
  const since = input.since ? new Date(input.since) : null;
  const source = input.source ?? null;

  let settlements: any[] = [];
  let totalPredictions = 0;
  let distinctVersions: { modelVersion: string }[] = [];
  try {
    settlements = await prisma.settlement.findMany({
      where: since ? { settledAt: { gte: since } } : undefined,
      include: { window: { include: { prediction: true } } },
      orderBy: { settledAt: "asc" },
    });
  } catch {}

  let filtered = settlements;
  if (source) filtered = settlements.filter((s) => (s as unknown as { window: { source: string } }).window.source === source);

  try {
    totalPredictions = await prisma.prediction.count(source ? { where: { window: { source: source as "LIVE" | "BACKTEST" } } } : undefined);
  } catch {}
  const totalSettled = filtered.length;

  const brierInputs: { p: number; outcome: number }[] = [];
  let modelVersion: string | null = null;
  for (const s of filtered) {
    const p = s.window.prediction;
    if (!p) continue;
    if ((s as unknown as { voided?: boolean }).voided || s.outcome == null) continue;
    brierInputs.push({ p: p.modelPUp, outcome: s.outcome === "UP" ? 1 : 0 });
    if (!modelVersion) modelVersion = p.modelVersion;
  }

  const brierScore = brier(brierInputs);

  // Deciles
  const buckets: Array<{
    binLow: number;
    binHigh: number;
    binCenter: number;
    n: number;
    avgPredicted: number | null;
    observedFreq: number | null;
    source: string;
  }> = [];
  for (let i = 0; i < 10; i++) {
    const binLow = i / 10;
    const binHigh = (i + 1) / 10;
    const binCenter = (binLow + binHigh) / 2;
    const inBin = filtered.filter((s) => {
      if ((s as unknown as { voided?: boolean }).voided || s.outcome == null) return false;
      const p = s.window.prediction?.modelPUp;
      if (p == null) return false;
      if (i === 9) return p >= binLow && p <= binHigh;
      return p >= binLow && p < binHigh;
    });
    const n = inBin.length;
    let avgPredicted: number | null = null;
    let observedFreq: number | null = null;
    let bucketSource = "LIVE";
    if (n > 0) {
      avgPredicted = inBin.reduce((s, x) => s + (x.window.prediction?.modelPUp ?? 0), 0) / n;
      observedFreq = inBin.filter((x) => x.outcome === "UP").length / n;
      const srcs = new Set(inBin.map((x) => x.window.source));
      bucketSource = srcs.size > 1 ? "MIXED" : (Array.from(srcs)[0] as string) ?? "LIVE";
    }
    buckets.push({ binLow, binHigh, binCenter, n, avgPredicted, observedFreq, source: bucketSource });
  }

  try {
    distinctVersions = await prisma.prediction.findMany({ distinct: ["modelVersion"], select: { modelVersion: true } });
  } catch {}

  return {
    brierScore,
    buckets,
    coverage: { totalPredictions, totalSettled },
    modelVersion,
    modelVersionHistory: distinctVersions.map((v) => v.modelVersion),
    provenance: {
      asOf: new Date().toISOString(),
      nObservations: totalSettled,
      modelVersion,
    },
  };
}
