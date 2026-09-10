#!/usr/bin/env tsx
import "dotenv/config";
import { prisma } from "../ledger/db";
import * as adapter from "../adapter/dreamdexClient";
import * as repo from "../ledger/repository";

async function ingestSettlements() {
  console.log(`[ingest] ${new Date().toISOString()} checking for settlements...`);

  // Find windows past closeTs still in tradable states (OPEN or LOCKED) — per new schema
  const openPastClose = await prisma.window.findMany({
    where: { status: { in: ["OPEN", "LOCKED"] }, closeTs: { lt: new Date() } },
    orderBy: { closeTs: "asc" },
    take: 100,
  });

  if (openPastClose.length === 0) {
    console.log("[ingest] No OPEN/LOCKED windows past close — nothing to settle");
  }

  const sinceTs =
    openPastClose.length > 0 ? openPastClose[0].closeTs : new Date(Date.now() - 24 * 60 * 60 * 1000);

  let exchangeSettlements: Awaited<ReturnType<typeof adapter.getFinalizedWindows>> = [];
  try {
    exchangeSettlements = await adapter.getFinalizedWindows(sinceTs);
    console.log(`[ingest] Exchange returned ${exchangeSettlements.length} finalized settlements since ${sinceTs.toISOString()}`);
  } catch (e) {
    console.warn("[ingest] getFinalizedWindows failed:", e);
  }

  const exchangeMap = new Map(exchangeSettlements.map((s) => [s.exchangeWindowId, s]));

  for (const win of openPastClose) {
    const ex = exchangeMap.get(win.exchangeWindowId);
    if (ex) {
      // (a) Write Settlement — outcome may be null when voided, both sides redeem at 0.5
      const existing = await prisma.settlement.findUnique({ where: { windowId: win.id } });
      if (!existing) {
        await repo.upsertSettlement(win.id, ex.outcome as import("@prisma/client").Direction | null, ex.voided);
        console.log(`[ingest] Settled ${win.exchangeWindowId} => ${ex.voided ? "VOIDED" : ex.outcome} (from chain, oracleQuestionId=${ex.oracleQuestionId ?? win.oracleQuestionId})`);
      }
      // Update window status: SETTLED or VOIDED
      await prisma.window.update({
        where: { id: win.id },
        data: { status: ex.voided ? "VOIDED" : "SETTLED", oracleQuestionId: ex.oracleQuestionId ?? win.oracleQuestionId ?? undefined },
      });

      // (b) Redeem winnings for any Order not yet redeemed (per M4: redeem is separate from settlement)
      const prediction = await prisma.prediction.findUnique({
        where: { windowId: win.id },
        include: { decision: { include: { order: true } } },
      });
      const order = prediction?.decision?.order;
      if (order && !order.redeemed) {
        // Check if we should redeem: voided → redeem both (adapter handles), else only if winning
        // For simplicity, always attempt redeem; adapter will handle voided vs winning
        try {
          const res = await adapter.redeemWinnings(win.exchangeWindowId);
          if (res.redeemed) {
            await prisma.order.update({
              where: { id: order.id },
              data: { redeemed: true, redeemedAt: new Date(), status: ex.voided ? "FINALIZED_WIN" : order.status },
            });
            console.log(`[ingest] Redeemed ${win.exchangeWindowId} order ${order.exchangeOrderId} voided=${ex.voided}`);
          }
        } catch (e) {
          console.warn(`[ingest] redeemWinnings failed for ${win.exchangeWindowId}: ${String(e)}`);
        }
      } else if (prediction?.decision?.action === "TRADE" && !order) {
        console.error(`[ingest] RECONCILE ALERT: window ${win.exchangeWindowId} has TRADE decision but no Order row — possible crash between exchange call and DB write.`);
      }
    } else {
      // No exchange data — mock settlement for dev (deterministic, respects voided)
      const isMock = win.exchangeWindowId.startsWith("0xmock-") || win.exchangeWindowId.startsWith("ETH-") || win.exchangeWindowId.startsWith("BTC-");
      const isMockMode = (process.env.TESTNET_WALLET_PRIVATE_KEY ?? "").startsWith("0x000000");
      if (isMock && isMockMode) {
        let h = 0;
        for (let i = 0; i < win.exchangeWindowId.length; i++) h = (h * 31 + win.exchangeWindowId.charCodeAt(i)) >>> 0;
        // 2% void rate for realism
        const voided = h % 50 === 0;
        const outcome = voided ? null : h % 2 === 0 ? "UP" : "DOWN";
        const existing = await prisma.settlement.findUnique({ where: { windowId: win.id } });
        if (!existing) {
          await repo.upsertSettlement(win.id, outcome as import("@prisma/client").Direction | null, voided);
          console.log(`[ingest] Mock-settled ${win.exchangeWindowId} => ${voided ? "VOIDED" : outcome}`);
        }
        await prisma.window.update({ where: { id: win.id }, data: { status: voided ? "VOIDED" : "SETTLED" } });

        // Mock redemption for any unredeemed order
        const pred = await prisma.prediction.findUnique({ where: { windowId: win.id }, include: { decision: { include: { order: true } } } });
        if (pred?.decision?.order && !pred.decision.order.redeemed) {
          await prisma.order.update({ where: { id: pred.decision.order.id }, data: { redeemed: true, redeemedAt: new Date() } });
          console.log(`[ingest] Mock-redeemed ${win.exchangeWindowId}`);
        }
      } else {
        // Real mode but no settlement yet — leave OPEN/LOCKED, will retry
        const staleMs = Date.now() - win.closeTs.getTime();
        const durationMs = win.duration === "FIFTEEN_MIN" ? 15 * 60 * 1000 : 60 * 60 * 1000;
        if (staleMs > 3 * durationMs) {
          console.warn(`[ingest] Window ${win.exchangeWindowId} stale (${Math.round(staleMs / 60000)}m past close) with no finalization — marking MISSED`);
          await prisma.window.update({ where: { id: win.id }, data: { status: "MISSED" } });
        }
        // Nice-to-have permissionless fallback per M4: pokeOracle / voidExpired
        // Only attempt if we have an oracleQuestionId and it's been stale long enough
        const oracleQ = win.oracleQuestionId;
        if (oracleQ && staleMs > 5 * durationMs) {
          try {
            const poked = await adapter.pokeOracle(oracleQ);
            if (poked) console.log(`[ingest] poked oracle ${oracleQ} for ${win.exchangeWindowId}`);
            else {
              const voided = await adapter.voidExpired(win.exchangeWindowId);
              if (voided) console.log(`[ingest] voidExpired ${win.exchangeWindowId}`);
            }
          } catch {}
        }
      }
    }
  }

  console.log("[ingest] Done");
}

ingestSettlements()
  .catch((e) => {
    console.error("[ingest] FAILED:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
