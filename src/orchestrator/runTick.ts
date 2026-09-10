#!/usr/bin/env tsx
import "dotenv/config";
import type { Asset, Duration } from "@prisma/client";
import { evaluateAndAct } from "./evaluateAndAct";

async function main() {
  const asset = (process.env.ASSET ?? process.argv[2] ?? "ETH") as Asset;
  const duration = (process.env.DURATION ?? process.argv[3] ?? "FIFTEEN_MIN") as Duration;

  if (!["BTC", "ETH"].includes(asset)) {
    console.error(`Invalid ASSET: ${asset} — must be BTC or ETH`);
    process.exit(1);
  }
  if (!["FIFTEEN_MIN", "ONE_HOUR"].includes(duration)) {
    console.error(`Invalid DURATION: ${duration}`);
    process.exit(1);
  }

  console.log(`[runTick] ${new Date().toISOString()} asset=${asset} duration=${duration}`);
  try {
    const result = await evaluateAndAct(asset, duration);
    console.log(JSON.stringify(result, null, 2));
    if (result.acted) console.log(`[runTick] TRADE fired: ${result.order?.side} stake=${result.decision.stake}`);
    else console.log(`[runTick] SKIP: ${result.reason}`);
  } catch (e) {
    console.error("[runTick] FAILED:", e);
    process.exit(1);
  } finally {
    const { prisma } = await import("../ledger/db");
    await prisma.$disconnect();
  }
}

main();
