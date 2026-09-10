import { prisma } from "./db";
import type {
  Window,
  Prediction,
  Decision,
  Order,
  Settlement,
  RiskLimits,
  Asset,
  Duration,
  DataSource,
  Direction,
  DecisionAction,
  DecisionReason,
  WindowStatus,
} from "@prisma/client";

// ─── Window ───────────────────────────────────────────────────────────────

export async function saveWindow(data: {
  asset: Asset;
  duration: Duration;
  openTs: Date;
  closeTs: Date;
  exchangeWindowId: string;
  oracleQuestionId?: string | null;
  status?: WindowStatus;
  source?: DataSource;
}): Promise<Window> {
  return prisma.window.upsert({
    where: { exchangeWindowId: data.exchangeWindowId },
    update: {
      status: data.status,
      source: data.source,
      oracleQuestionId: data.oracleQuestionId ?? undefined,
    },
    create: {
      asset: data.asset,
      duration: data.duration,
      openTs: data.openTs,
      closeTs: data.closeTs,
      exchangeWindowId: data.exchangeWindowId,
      oracleQuestionId: data.oracleQuestionId ?? null,
      status: data.status ?? "OPEN",
      source: data.source ?? "LIVE",
    },
  });
}

export async function getOrCreateOpenWindow(
  asset: Asset,
  duration: Duration,
  exchangeWindowId: string,
  openTs: Date,
  closeTs: Date,
  source: DataSource = "LIVE",
  oracleQuestionId?: string | null
): Promise<Window> {
  return prisma.window.upsert({
    where: { exchangeWindowId },
    update: { oracleQuestionId: oracleQuestionId ?? undefined },
    create: { asset, duration, exchangeWindowId, openTs, closeTs, source, oracleQuestionId: oracleQuestionId ?? null },
  });
}

export async function getWindowByExchangeId(exchangeWindowId: string): Promise<Window | null> {
  return prisma.window.findUnique({ where: { exchangeWindowId } });
}

export async function updateWindowStatus(exchangeWindowId: string, status: WindowStatus): Promise<Window> {
  return prisma.window.update({ where: { exchangeWindowId }, data: { status } });
}

// ─── Prediction ───────────────────────────────────────────────────────────

export async function savePrediction(data: {
  windowId: string;
  modelPUp: number;
  marketPUp: number;
  edge: number;
  confidenceLow: number;
  confidenceHigh: number;
  modelVersion: string;
  nObservations: number;
}): Promise<Prediction> {
  return prisma.prediction.create({ data });
}

export async function getPredictionByWindowId(windowId: string): Promise<Prediction | null> {
  return prisma.prediction.findUnique({ where: { windowId } });
}

export async function predictionExistsForWindow(windowId: string): Promise<boolean> {
  const p = await prisma.prediction.findUnique({ where: { windowId }, select: { id: true } });
  return !!p;
}

export async function predictionExistsForExchangeWindow(exchangeWindowId: string): Promise<boolean> {
  const win = await prisma.window.findUnique({
    where: { exchangeWindowId },
    select: { id: true },
  });
  if (!win) return false;
  return predictionExistsForWindow(win.id);
}

// ─── Decision ─────────────────────────────────────────────────────────────

export async function saveDecision(data: {
  predictionId: string;
  action: DecisionAction;
  reason: DecisionReason;
  stake?: number | null;
  kellyFraction?: number | null;
}): Promise<Decision> {
  return prisma.decision.create({ data });
}

export async function getRecentDecisions(limit = 50): Promise<
  (Decision & { prediction: Prediction & { window: Window }; order: Order | null })[]
> {
  return prisma.decision.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      prediction: { include: { window: true } },
      order: true,
    },
  });
}

// ─── Order ────────────────────────────────────────────────────────────────

export async function saveOrder(data: {
  decisionId: string;
  exchangeOrderId: string;
  side: Direction;
  stake: number;
  status?: import("@prisma/client").OrderStatus;
}): Promise<Order> {
  return prisma.order.create({
    data: {
      decisionId: data.decisionId,
      exchangeOrderId: data.exchangeOrderId,
      side: data.side,
      stake: data.stake,
      status: data.status ?? "PLACED",
    },
  });
}

export async function markOrderRedeemed(exchangeOrderId: string): Promise<Order | null> {
  try {
    return await prisma.order.update({
      where: { exchangeOrderId },
      data: { redeemed: true, redeemedAt: new Date(), status: "FINALIZED_WIN" },
    });
  } catch {
    return null;
  }
}

export async function markOrderFinalized(exchangeOrderId: string, isWin: boolean): Promise<Order | null> {
  try {
    return await prisma.order.update({
      where: { exchangeOrderId },
      data: {
        status: isWin ? "FINALIZED_WIN" : "FINALIZED_LOSS",
        redeemed: true,
        redeemedAt: new Date(),
      },
    });
  } catch {
    return null;
  }
}

// ─── Settlement ───────────────────────────────────────────────────────────

export async function saveSettlement(data: {
  windowId: string;
  outcome?: Direction | null;
  voided?: boolean;
}): Promise<Settlement> {
  return prisma.settlement.create({
    data: {
      windowId: data.windowId,
      outcome: data.outcome ?? null,
      voided: data.voided ?? false,
    },
  });
}

export async function upsertSettlement(windowId: string, outcome: Direction | null, voided = false): Promise<Settlement> {
  return prisma.settlement.upsert({
    where: { windowId },
    update: { outcome, voided },
    create: { windowId, outcome, voided },
  });
}

export async function getUnsettledWindows(): Promise<Window[]> {
  return prisma.window.findMany({
    where: { status: "OPEN", closeTs: { lt: new Date() } },
    orderBy: { closeTs: "asc" },
  });
}

// ─── RiskLimits ───────────────────────────────────────────────────────────

export async function getRiskLimits(): Promise<RiskLimits> {
  let limits = await prisma.riskLimits.findUnique({ where: { id: 1 } });
  if (!limits) {
    limits = await prisma.riskLimits.create({
      data: { id: 1, maxStakePerTrade: 5, maxDailyStake: 30, minEdgeThreshold: 0.05, killSwitch: false },
    });
  }
  return limits;
}

export async function updateRiskLimits(data: Partial<Omit<RiskLimits, "id" | "updatedAt">>): Promise<RiskLimits> {
  return prisma.riskLimits.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, ...data } as RiskLimits,
  });
}

// ─── Aggregates for dashboard / MCP ───────────────────────────────────────

export async function getCalibrationData(source?: DataSource): Promise<
  (Prediction & { window: Window })[]
> {
  return prisma.prediction.findMany({
    where: source ? { window: { source } } : undefined,
    include: { window: true },
  }) as unknown as Promise<(Prediction & { window: Window })[]>;
}

export async function getCalibrationDataResolved(source?: DataSource) {
  // Predictions joined to settlement — only resolved
  const settlements = await prisma.settlement.findMany({
    include: {
      window: {
        include: { prediction: true },
      },
    },
    orderBy: { settledAt: "asc" },
  });
  let filtered = settlements;
  if (source) filtered = settlements.filter((s) => s.window.source === source);
  return filtered;
}

export async function getRecentSettlements(limit = 200) {
  return prisma.settlement.findMany({
    orderBy: { settledAt: "desc" },
    take: limit,
    include: { window: { include: { prediction: true } } },
  });
}

export async function getDailyStakeTotal(dayStartUtc: Date): Promise<number> {
  const orders = await prisma.order.findMany({
    where: { placedAt: { gte: dayStartUtc } },
    select: { stake: true },
  });
  return orders.reduce((sum, o) => sum + o.stake, 0);
}

export async function getSystemStatusSnapshot(): Promise<{
  riskLimits: RiskLimits;
  windowCount: number;
  predictionCount: number;
  settlementCount: number;
  lastSettlement: Settlement | null;
  lastPrediction: Prediction | null;
}> {
  const [riskLimits, windowCount, predictionCount, settlementCount, lastSettlement, lastPrediction] =
    await Promise.all([
      getRiskLimits(),
      prisma.window.count(),
      prisma.prediction.count(),
      prisma.settlement.count(),
      prisma.settlement.findFirst({ orderBy: { settledAt: "desc" } }),
      prisma.prediction.findFirst({ orderBy: { createdAt: "desc" } }),
    ]);
  return { riskLimits, windowCount, predictionCount, settlementCount, lastSettlement, lastPrediction };
}

// ─── Utility for backtest seeding ─────────────────────────────────────────
export async function clearBacktestData(): Promise<void> {
  // Delete in FK order
  const backtestWindows = await prisma.window.findMany({ where: { source: "BACKTEST" }, select: { id: true } });
  const ids = backtestWindows.map((w) => w.id);
  if (ids.length === 0) return;
  const predictions = await prisma.prediction.findMany({ where: { windowId: { in: ids } }, select: { id: true } });
  const pIds = predictions.map((p) => p.id);
  const decisions = await prisma.decision.findMany({ where: { predictionId: { in: pIds } }, select: { id: true } });
  const dIds = decisions.map((d) => d.id);
  await prisma.order.deleteMany({ where: { decisionId: { in: dIds } } });
  await prisma.decision.deleteMany({ where: { id: { in: dIds } } });
  await prisma.settlement.deleteMany({ where: { windowId: { in: ids } } });
  await prisma.prediction.deleteMany({ where: { windowId: { in: ids } } });
  await prisma.window.deleteMany({ where: { id: { in: ids } } });
}
