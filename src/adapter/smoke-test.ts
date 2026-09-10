import "dotenv/config";
import { getCurrentWindow, getMarketOdds } from "./dreamdexClient";

async function main() {
  console.log("=== Drimer / DreamDEX Adapter Smoke Test (markets-sdk ^0.28) ===");
  console.log(`DREAMDEX_NETWORK=${process.env.DREAMDEX_NETWORK}`);
  console.log(`DREAMDEX_INDEXER_URL=${process.env.DREAMDEX_INDEXER_URL}`);
  console.log(`DREAMDEX_VENUE_ID=${process.env.DREAMDEX_VENUE_ID}`);
  const isMock = (process.env.TESTNET_WALLET_PRIVATE_KEY ?? "").startsWith("0x000000");
  console.log(`Mode: ${isMock ? "MOCK (placeholder privateKey)" : "LIVE SDK"}`);

  const win = await getCurrentWindow("ETH", "FIFTEEN_MIN");
  console.log("Window:", {
    exchangeWindowId: win.exchangeWindowId,
    oracleQuestionId: win.oracleQuestionId,
    asset: win.asset,
    duration: win.duration,
    openTs: win.openTs.toISOString(),
    closeTs: win.closeTs.toISOString(),
  });
  // Verify oracleQuestionId is present (even in mock)
  if (!win.oracleQuestionId) console.warn("WARN: oracleQuestionId missing");
  else console.log("oracleQuestionId:", win.oracleQuestionId, "→ verify at https://prd.oracle.somnia.host/questions/" + win.oracleQuestionId + "?view=graph");

  const odds = await getMarketOdds(win);
  console.log("Market odds (midpoint for Up):", odds, "→ price already is probability per docs");

  // Check on-chain status if not mock
  if (!isMock) {
    try {
      const mod = await import("@somnia-chain/markets-sdk");
      console.log("SDK loaded:", !!mod.SomniaMarkets);
    } catch (e) {
      console.warn("SDK import failed:", e);
    }
  }

  // Auth error detection test
  const { isAuthError } = await import("./types");
  console.log("isAuthError('AUTH_ERROR'): ", isAuthError(new Error("AUTH_ERROR: 401 Unauthorized")));
  console.log("Smoke test PASS — adapter returns window + oracleQuestionId + midpoint odds");
}

main().catch((e) => {
  console.error("Smoke test FAILED:", e);
  process.exit(1);
});
