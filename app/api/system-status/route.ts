import { NextResponse } from "next/server";
import * as repo from "@/src/ledger/repository";
import * as adapter from "@/src/adapter/dreamdexClient";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    let snap: Awaited<ReturnType<typeof repo.getSystemStatusSnapshot>> | null = null;
    try {
      snap = await repo.getSystemStatusSnapshot();
    } catch (e) {
      console.warn("[api/system-status] DB unreachable:", e);
    }
    let exchangeConnectionOk = true;
    try {
      exchangeConnectionOk = await adapter.checkConnection();
    } catch {
      exchangeConnectionOk = false;
    }
    if (!snap) {
      return NextResponse.json({
        exchangeConnectionOk,
        lastSettlementProcessedAt: null,
        lastModelUpdateAt: null,
        killSwitchActive: false,
        riskLimits: { id: 1, maxStakePerTrade: 5, maxDailyStake: 30, minEdgeThreshold: 0.05, killSwitch: false, updatedAt: new Date().toISOString() },
        counts: { windows: 0, predictions: 0, settlements: 0 },
        asOf: new Date().toISOString(),
        _error: "DB unreachable — showing defaults",
      });
    }
    return NextResponse.json({
      exchangeConnectionOk,
      lastSettlementProcessedAt: snap.lastSettlement?.settledAt?.toISOString() ?? null,
      lastModelUpdateAt: snap.lastPrediction?.createdAt?.toISOString() ?? null,
      killSwitchActive: snap.riskLimits.killSwitch,
      riskLimits: snap.riskLimits,
      counts: {
        windows: snap.windowCount,
        predictions: snap.predictionCount,
        settlements: snap.settlementCount,
      },
      asOf: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[api/system-status] error:", e);
    return NextResponse.json({ error: String(e), asOf: new Date().toISOString() }, { status: 200 });
  }
}
