import { z } from "zod";
import * as repo from "../../ledger/repository";
import * as adapter from "../../adapter/dreamdexClient";

export const name = "get_system_status";
export const description =
  "One-call health of every subsystem: exchange connection alive, timestamp of last settlement processed, timestamp of last model update, kill-switch state, plus ledger counts. Use this to diagnose 'why hasn't it done anything in an hour' without cross-referencing five services.";

export const inputSchema = z.object({});

export async function handler(_input: z.infer<typeof inputSchema>) {
  let snap: Awaited<ReturnType<typeof repo.getSystemStatusSnapshot>> | null = null;
  try {
    snap = await repo.getSystemStatusSnapshot();
  } catch {}
  let exchangeConnectionOk = true;
  try {
    exchangeConnectionOk = await adapter.checkConnection();
  } catch {
    exchangeConnectionOk = false;
  }
  if (!snap) {
    return {
      exchangeConnectionOk,
      lastSettlementProcessedAt: null,
      lastModelUpdateAt: null,
      killSwitchActive: false,
      riskLimits: { id: 1, maxStakePerTrade: 5, maxDailyStake: 30, minEdgeThreshold: 0.05, killSwitch: false, updatedAt: new Date().toISOString() },
      counts: { windows: 0, predictions: 0, settlements: 0 },
      provenance: { asOf: new Date().toISOString(), modelVersion: null, note: "DB unreachable — showing defaults" },
    };
  }
  return {
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
    provenance: {
      asOf: new Date().toISOString(),
      modelVersion: snap.lastPrediction ? (await import("../../decision/calibrate")).MODEL_VERSION : null,
    },
  };
}
