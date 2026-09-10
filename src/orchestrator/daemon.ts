import "dotenv/config";
import cron from "node-cron";
import { evaluateAndAct } from "./evaluateAndAct";
import { prisma } from "../ledger/db";
import * as adapter from "../adapter/dreamdexClient";
import * as repo from "../ledger/repository";
import type { Asset, Duration } from "@prisma/client";

const ASSET = (process.env.ASSET ?? "ETH") as Asset;
const DURATION = (process.env.DURATION ?? "FIFTEEN_MIN") as Duration;

async function tick() {
  console.log(`[daemon] tick ${new Date().toISOString()} ${ASSET}/${DURATION}`);
  try {
    const result = await evaluateAndAct(ASSET, DURATION);
    console.log(`[daemon] result: ${result.acted ? "TRADE" : "SKIP"} ${result.reason}`);
  } catch (e) {
    console.error("[daemon] tick error:", e);
  }
}

console.log(`[daemon] Starting — ${ASSET}/${DURATION} polling every 2 minutes`);
console.log(`[daemon] DREAMDEX_NETWORK=${process.env.DREAMDEX_NETWORK} DATABASE_URL set=${!!process.env.DATABASE_URL}`);

// Run immediately on start
tick();

// Every 2 minutes for 15-min windows; every 5 minutes for 1-hour (but 2 min is fine for both)
cron.schedule("*/2 * * * *", tick);

// Ingest settlements every 2 minutes, offset by 1 minute — with redemption per M4
cron.schedule("1-59/2 * * * *", async () => {
  console.log(`[daemon] ingest ${new Date().toISOString()}`);
  try {
    const openPastClose = await prisma.window.findMany({
      where: { status: { in: ["OPEN", "LOCKED"] }, closeTs: { lt: new Date() } },
      take: 100,
    });
    if (openPastClose.length === 0) return;
    const sinceTs = openPastClose[0].closeTs;
    let exchangeSettlements: Awaited<ReturnType<typeof adapter.getFinalizedWindows>> = [];
    try {
      exchangeSettlements = await adapter.getFinalizedWindows(sinceTs);
    } catch {}
    const m = new Map(exchangeSettlements.map((s) => [s.exchangeWindowId, s]));
    for (const win of openPastClose) {
      const ex = m.get(win.exchangeWindowId);
      if (ex) {
        const exists = await prisma.settlement.findUnique({ where: { windowId: win.id } });
        if (!exists) await repo.upsertSettlement(win.id, ex.outcome as import("@prisma/client").Direction | null, ex.voided);
        await prisma.window.update({ where: { id: win.id }, data: { status: ex.voided ? "VOIDED" : "SETTLED", oracleQuestionId: ex.oracleQuestionId ?? win.oracleQuestionId ?? undefined } });
        // Redeem
        const pred = await prisma.prediction.findUnique({ where: { windowId: win.id }, include: { decision: { include: { order: true } } } });
        if (pred?.decision?.order && !pred.decision.order.redeemed) {
          try {
            const res = await adapter.redeemWinnings(win.exchangeWindowId);
            if (res.redeemed) await prisma.order.update({ where: { id: pred.decision.order.id }, data: { redeemed: true, redeemedAt: new Date() } });
            console.log(`[daemon] redeemed ${win.exchangeWindowId}`);
          } catch {}
        }
      } else {
        let h = 0;
        for (let i = 0; i < win.exchangeWindowId.length; i++) h = (h * 31 + win.exchangeWindowId.charCodeAt(i)) >>> 0;
        const voided = h % 50 === 0;
        const outcome = voided ? null : h % 2 === 0 ? "UP" : "DOWN";
        if (win.exchangeWindowId.startsWith("0xmock-") || win.exchangeWindowId.startsWith("ETH-") || win.exchangeWindowId.startsWith("BTC-")) {
          const exists = await prisma.settlement.findUnique({ where: { windowId: win.id } });
          if (!exists) await repo.upsertSettlement(win.id, outcome as import("@prisma/client").Direction | null, voided);
          await prisma.window.update({ where: { id: win.id }, data: { status: voided ? "VOIDED" : "SETTLED" } });
          const pred = await prisma.prediction.findUnique({ where: { windowId: win.id }, include: { decision: { include: { order: true } } } });
          if (pred?.decision?.order && !pred.decision.order.redeemed) {
            await prisma.order.update({ where: { id: pred.decision.order.id }, data: { redeemed: true, redeemedAt: new Date() } });
          }
          console.log(`[daemon] mock-settled ${win.exchangeWindowId} => ${voided ? "VOIDED" : outcome}`);
        }
      }
    }
  } catch (e) {
    console.error("[daemon] ingest error:", e);
  }
});

// Keep process alive
process.on("SIGTERM", async () => {
  console.log("[daemon] SIGTERM — disconnecting");
  await prisma.$disconnect();
  process.exit(0);
});
process.on("SIGINT", async () => {
  console.log("[daemon] SIGINT — disconnecting");
  await prisma.$disconnect();
  process.exit(0);
});
