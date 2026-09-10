import "dotenv/config";
import type { Direction } from "@prisma/client";

/**
 * Primary backtest source per implementation.md M7 (upgraded).
 * DreamDEX retains full history for every finalized market indefinitely — fills, candles,
 * and the resolution record all survive settlement. This is stronger than a synthetic
 * external price feed: "this is DreamDEX's own settled history, not a simulation".
 *
 * Scope any getCandles/getFills calls strictly to that market's own window
 * ({ from: tradingStart, to: expiry }) — pools are recycled, so unscoped reads
 * return fills from unrelated windows.
 *
 * Keep fetchHistoricalPrices.ts as fallback if testnet doesn't have 60-90 days yet.
 */

export type DreamdexWindowSpec = {
  exchangeWindowId: string; // real marketId (bytes32) — so oracleQuestionId works on backtest rows too
  oracleQuestionId: string | null;
  asset: "BTC" | "ETH";
  duration: "FIFTEEN_MIN" | "ONE_HOUR";
  openTs: Date;
  closeTs: Date;
  outcome: Direction | null; // null when voided
  voided: boolean;
};

function isMockMode(): boolean {
  const key = process.env.TESTNET_WALLET_PRIVATE_KEY ?? process.env.SESSION_KEY ?? "";
  if (!key) return true;
  if (key.startsWith("0x000000")) return true;
  if (/0{12,}/.test(key)) return true;
  return false;
}

export async function fetchDreamdexHistory(opts?: {
  asset?: "BTC" | "ETH";
  duration?: "FIFTEEN_MIN" | "ONE_HOUR";
  limit?: number;
}): Promise<DreamdexWindowSpec[]> {
  if (isMockMode()) {
    console.log("[fetchDreamdexHistory] mock mode — privateKey placeholder, returning empty (fallback will be used)");
    return [];
  }

  const venueId = process.env.DREAMDEX_VENUE_ID ?? "";
  if (!venueId) {
    console.warn("[fetchDreamdexHistory] DREAMDEX_VENUE_ID not set — returning empty");
    return [];
  }

  try {
    const mod = await import("@somnia-chain/markets-sdk");
    const { SomniaMarkets } = mod as unknown as { SomniaMarkets: new (c: Record<string, unknown>) => unknown };
    const indexerUrl = process.env.DREAMDEX_INDEXER_URL ?? process.env.DREAMDEX_RPC_URL ?? "";
    const wsRpcUrl = process.env.DREAMDEX_WS_RPC_URL ?? "wss://shannon-rpc.somnia.network/ws";
    const privateKey = (process.env.TESTNET_WALLET_PRIVATE_KEY ?? "") as `0x${string}`;
    const chain = { id: 50312, name: "Somnia Shannon Testnet", network: "shannon-testnet", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 } } as unknown;

    const exchange = new SomniaMarkets({ chain, wsRpcUrl, indexerUrl, privateKey } as never) as unknown as {
      loadMarkets?: () => Promise<void>;
      client: Record<string, unknown>;
    };
    if (exchange.loadMarkets) await exchange.loadMarkets();
    const client = exchange.client as {
      listBinaryMarkets: (o: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
      getMarketResolution: (id: string) => Promise<Record<string, unknown>>;
    };

    const markets = (await client.listBinaryMarkets({ venueId, status: "Finalized", limit: opts?.limit ?? 500 })) as Record<string, unknown>[];
    const filtered = markets.filter((m) => {
      if (opts?.asset) {
        const assetRaw = String((m as { asset?: string }).asset ?? (m as { symbol?: string }).symbol ?? "").toUpperCase();
        if (!assetRaw.includes(opts.asset)) return false;
      }
      if (opts?.duration) {
        const intervalSec = Number((m as { intervalSec?: number }).intervalSec ?? 0);
        const want = opts.duration === "FIFTEEN_MIN" ? 900 : 3600;
        if (intervalSec && intervalSec !== want) return false;
      }
      return true;
    });

    const results: DreamdexWindowSpec[] = [];
    for (const m of filtered) {
      const marketId = String((m as { marketId?: string }).marketId ?? (m as { id?: string }).id ?? "");
      if (!marketId) continue;
      const oracleQuestionId = String((m as { oracleQuestionId?: string }).oracleQuestionId ?? (m as { questionId?: string }).questionId ?? "") || null;
      const assetRaw = String((m as { asset?: string }).asset ?? "").toUpperCase();
      const asset: "BTC" | "ETH" = assetRaw.includes("BTC") ? "BTC" : "ETH";
      const intervalSec = Number((m as { intervalSec?: number }).intervalSec ?? 900);
      const duration: "FIFTEEN_MIN" | "ONE_HOUR" = intervalSec === 3600 ? "ONE_HOUR" : "FIFTEEN_MIN";
      const tradingStart = Number((m as { tradingStart?: number }).tradingStart ?? (m as { startTime?: number }).startTime ?? 0);
      const expiry = Number((m as { expiry?: number }).expiry ?? (m as { endTime?: number }).endTime ?? tradingStart + intervalSec);
      const openTs = new Date(tradingStart * 1000);
      const closeTs = new Date(expiry * 1000);

      let outcome: Direction | null = null;
      let voided = Boolean((m as { voided?: boolean }).voided ?? false);
      try {
        const resolution = await client.getMarketResolution(marketId);
        voided = Boolean((resolution as { voided?: boolean }).voided ?? voided);
        if (!voided) {
          const closing = (resolution as { closingAnswer?: { numericValue?: number } }).closingAnswer?.numericValue;
          const opening = (resolution as { openingAnswer?: { numericValue?: number } }).openingAnswer?.numericValue;
          if (typeof closing === "number" && typeof opening === "number") outcome = closing > opening ? "UP" : "DOWN";
          else {
            const raw = String((resolution as { outcome?: string }).outcome ?? "").toUpperCase();
            if (raw === "UP" || raw === "DOWN") outcome = raw as Direction;
          }
        }
      } catch (e) {
        console.warn(`[fetchDreamdexHistory] getMarketResolution failed for ${marketId}: ${String(e)}`);
      }

      results.push({ exchangeWindowId: marketId, oracleQuestionId, asset, duration, openTs, closeTs, outcome, voided });
    }

    console.log(`[fetchDreamdexHistory] fetched ${results.length} finalized DreamDEX windows (voided: ${results.filter((r) => r.voided).length})`);
    // Scope check per gotcha: we already scoped by marketId, not poolAddress, and by window from/to — pools recycled, not used
    return results.sort((a, b) => a.openTs.getTime() - b.openTs.getTime());
  } catch (e) {
    console.warn(`[fetchDreamdexHistory] failed, fallback will be used: ${String(e)}`);
    return [];
  }
}

if (require.main === module) {
  (async () => {
    const rows = await fetchDreamdexHistory({ limit: 10 });
    console.log(`Got ${rows.length} rows`, rows.slice(0, 2));
  })();
}
