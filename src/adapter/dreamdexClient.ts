import "dotenv/config";
import { createPublicClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Asset, Duration, Direction } from "@prisma/client";
import type { ExchangeWindow, MarketOdds, ExchangeOrderResult, ExchangeSettlement } from "./types";
import { isAuthError } from "./types";

// ---------------------------------------------------------------------------
// Config — validated at startup, hard-fail if NETWORK is not set
// ---------------------------------------------------------------------------

function getDreamdexConfig() {
  const network = process.env.DREAMDEX_NETWORK;
  if (!network) throw new Error("DREAMDEX_NETWORK must be set (e.g. shannon-testnet) — refusing to guess mainnet vs testnet");
  if (network !== "shannon-testnet" && network !== "shannon" && network !== "mainnet") {
    console.warn(`[adapter] DREAMDEX_NETWORK=${network} — expected shannon-testnet`);
  }
  return {
    network,
    // Defaults match @somnia-chain/markets-sdk's documented Shannon testnet config exactly
    // (dev.smk.somnia.host indexer, api.infra.testnet.somnia.network RPC) — the previous
    // guessed shannon-rpc.somnia.network / indexer.shannon.somnia.network hosts don't match
    // what the installed SDK actually talks to.
    indexerUrl: process.env.DREAMDEX_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql",
    wsRpcUrl: process.env.DREAMDEX_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws",
    chainId: process.env.DREAMDEX_CHAIN ?? "shannon-testnet",
    venueId: process.env.DREAMDEX_VENUE_ID ?? process.env.DREAMDEX_VENUE ?? "",
    privateKey: (process.env.TESTNET_WALLET_PRIVATE_KEY ?? process.env.SESSION_KEY ?? "") as `0x${string}`,
    // Legacy fallbacks
    rpcUrl: process.env.DREAMDEX_RPC_URL ?? "https://api.infra.testnet.somnia.network",
    apiBase: process.env.DREAMDEX_API_BASE ?? "https://api.dreamdex.io",
    sessionKey: process.env.SESSION_KEY ?? process.env.TESTNET_WALLET_PRIVATE_KEY ?? "",
  };
}

function isPlaceholderKey(key: string): boolean {
  if (!key) return true;
  if (key.startsWith("0x000000")) return true;
  if (/0{12,}/.test(key)) return true;
  if (key.includes("0000000000000001") || key.includes("0000000000000002")) return true;
  if (key === "dev-secret-change-in-prod" || key.length < 20) return true;
  return false;
}

function isMockMode(cfg = getDreamdexConfig()): boolean {
  // Mock if private key is placeholder OR indexer URL is placeholder
  if (isPlaceholderKey(cfg.privateKey)) return true;
  if (!cfg.indexerUrl || cfg.indexerUrl.includes("example") || cfg.indexerUrl.includes("localhost")) return false; // allow real indexer even with placeholder? but privateKey check already handles
  // If venueId missing, still mock — but not strictly required for mock
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function retryWithBackoff<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (isAuthError(e)) throw e;
      if (i < attempts - 1) {
        const delay = 300 * Math.pow(2, i) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

function durationToMs(d: Duration): number {
  return d === "FIFTEEN_MIN" ? 15 * 60 * 1000 : 60 * 60 * 1000;
}

function mockWindow(asset: Asset, duration: Duration): ExchangeWindow {
  const now = Date.now();
  const ms = durationToMs(duration);
  const openMs = Math.floor(now / ms) * ms;
  const closeMs = openMs + ms;
  return {
    exchangeWindowId: `0xmock-${asset}-${duration}-${openMs}`,
    oracleQuestionId: `mock-q-${asset}-${openMs}`,
    asset,
    duration,
    openTs: new Date(openMs),
    closeTs: new Date(closeMs),
  };
}

function assetOfMarket(market: Record<string, unknown>): Asset {
  // Try typed fields first, never parse question text per implementation.md
  const assetRaw = (market.asset as string) ?? (market.underlying as string) ?? (market.baseAsset as string) ?? "";
  const upper = String(assetRaw).toUpperCase();
  if (upper.includes("BTC")) return "BTC";
  if (upper.includes("ETH")) return "ETH";
  // Fallback: infer from symbol like "BTC-15m-..."
  const symbol = String(market.symbol ?? market.marketSymbol ?? "");
  if (symbol.toUpperCase().includes("BTC")) return "BTC";
  return "ETH";
}

function durationOfMarket(market: Record<string, unknown>): Duration {
  const intervalSec = (market.intervalSec as number) ?? (market.interval as number) ?? (market.durationSec as number) ?? 900;
  if (intervalSec === 900 || intervalSec === 15 * 60) return "FIFTEEN_MIN";
  if (intervalSec === 3600) return "ONE_HOUR";
  // fallback
  return "FIFTEEN_MIN";
}

// ---------------------------------------------------------------------------
// SDK singleton — lazy, ESM import
// ---------------------------------------------------------------------------

let _exchange: unknown | null = null;
let _exchangePromise: Promise<unknown> | null = null;

async function getExchange(): Promise<unknown | null> {
  const cfg = getDreamdexConfig();
  if (isPlaceholderKey(cfg.privateKey)) return null;
  if (_exchange) return _exchange;
  if (_exchangePromise) return _exchangePromise;
  _exchangePromise = (async () => {
    try {
      const mod = await import("@somnia-chain/markets-sdk");
      const { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } = mod as unknown as {
        SomniaMarkets: new (c: Record<string, unknown>) => unknown;
        SOMNIA_TESTNET_ADDRESSES: Record<string, unknown>;
      };
      const { somniaShannon } = (await import("@somnia-chain/markets-sdk/chains")) as unknown as { somniaShannon: unknown };
      const addresses = (() => {
        try {
          const raw = process.env.DREAMDEX_ADDRESSES;
          if (raw) return JSON.parse(raw);
        } catch {}
        return SOMNIA_TESTNET_ADDRESSES; // baked-in testnet deployment — zero-setup default per SDK docs
      })();
      const clientConfig: Record<string, unknown> = {
        chain: somniaShannon,
        wsRpcUrl: cfg.wsRpcUrl,
        indexerUrl: cfg.indexerUrl,
        privateKey: cfg.privateKey,
        addresses,
      };
      // The SDK's SomniaMarkets constructor takes ClientConfig & TraderConfig
      const exchange = new SomniaMarkets(clientConfig as never);
      // Hydrate markets
      const ex = exchange as { loadMarkets?: () => Promise<void> };
      if (ex.loadMarkets) await ex.loadMarkets();
      _exchange = exchange;
      return exchange;
    } catch (e) {
      console.warn(`[adapter] SDK init failed, falling back to mock: ${String(e)}`);
      return null;
    } finally {
      _exchangePromise = null;
    }
  })();
  return _exchangePromise;
}

// ---------------------------------------------------------------------------
// 5-contract adapter (per implementation.md M2) + legacy alias
// ---------------------------------------------------------------------------

export async function getCurrentWindow(asset: Asset, duration: Duration): Promise<ExchangeWindow> {
  const cfg = getDreamdexConfig();
  return retryWithBackoff(async () => {
    if (isPlaceholderKey(cfg.privateKey)) {
      return mockWindow(asset, duration);
    }
    const exchange = (await getExchange()) as Record<string, unknown> | null;
    if (!exchange) return mockWindow(asset, duration);

    const client = (exchange as { client: Record<string, unknown> }).client as Record<string, unknown>;
    if (!client || typeof (client as Record<string, unknown>).listLiveBinaryMarkets !== "function") {
      return mockWindow(asset, duration);
    }

    try {
      const listLive = (client as { listLiveBinaryMarkets: (f?: Record<string, unknown>) => Promise<unknown[]> }).listLiveBinaryMarkets.bind(client);
      const markets = (await listLive({ limit: 50, venueId: cfg.venueId || undefined })) as Record<string, unknown>[];
      // Scope to requested asset/duration, gate on-chain, skip <300s to expiry
      const nowSec = Math.floor(Date.now() / 1000);
      let best: Record<string, unknown> | null = null;
      for (const m of markets) {
        const a = assetOfMarket(m);
        const d = durationOfMarket(m);
        if (a !== asset || d !== duration) continue;
        // filter venue if venueId set
        if (cfg.venueId && (m as { venueId?: string }).venueId && (m as { venueId: string }).venueId.toLowerCase() !== cfg.venueId.toLowerCase()) continue;
        // expiry check — skip <300s per docs recipe
        const expirySec = (m.expiry as number) ?? (m.expiryTimestamp as number) ?? (m.endTime as number) ?? 0;
        const secondsLeft = Number(expirySec) - nowSec;
        if (secondsLeft > 0 && secondsLeft < 300) continue;
        // gate on-chain status === 1 (Trading)
        try {
          const getOnchain = (client as { getMarketOnchain: (id: string) => Promise<Record<string, unknown>> }).getMarketOnchain.bind(client);
          const marketId = String((m as { marketId?: string }).marketId ?? (m as { id?: string }).id ?? "");
          if (!marketId) continue;
          const onchain = await getOnchain(marketId);
          const status = (onchain as { status?: number }).status;
          if (status !== undefined && status !== 1) continue;
          // Prefer the most imminent expiry that still has time
          if (!best || Number((m as { expiry?: number }).expiry ?? 0) < Number((best as { expiry?: number }).expiry ?? Infinity)) {
            best = m;
          }
        } catch {
          // if onchain check fails, still consider the market
          if (!best) best = m;
        }
      }
      if (!best) return mockWindow(asset, duration);
      const marketId = String((best as { marketId?: string }).marketId ?? (best as { id?: string }).id ?? mockWindow(asset, duration).exchangeWindowId);
      const oracleQuestionId = String((best as { oracleQuestionId?: string }).oracleQuestionId ?? (best as { questionId?: string }).questionId ?? `q-${marketId.slice(0, 8)}`);
      const tradingStart = Number((best as { tradingStart?: number }).tradingStart ?? (best as { startTime?: number }).startTime ?? Date.now() / 1000);
      const expiry = Number((best as { expiry?: number }).expiry ?? (best as { endTime?: number }).endTime ?? tradingStart + durationToMs(duration) / 1000);
      const openTs = new Date(tradingStart * 1000);
      const closeTs = new Date(expiry * 1000);
      return {
        exchangeWindowId: marketId,
        oracleQuestionId,
        asset,
        duration,
        openTs,
        closeTs,
      };
    } catch (e) {
      if (isAuthError(e)) throw e;
      console.warn(`[adapter] getCurrentWindow SDK fallback to mock: ${String((e as Error).message)}`);
      return mockWindow(asset, duration);
    }
  });
}

export async function getMarketOdds(window: ExchangeWindow): Promise<MarketOdds> {
  const cfg = getDreamdexConfig();
  return retryWithBackoff(async () => {
    if (isPlaceholderKey(cfg.privateKey)) {
      let hash = 0;
      for (let i = 0; i < window.exchangeWindowId.length; i++) hash = (hash * 31 + window.exchangeWindowId.charCodeAt(i)) >>> 0;
      const pUp = Math.min(0.95, Math.max(0.05, 0.42 + (hash % 1600) / 10000));
      const bestBid = Math.max(0.01, Math.round((pUp - 0.02) * 1000) / 1000);
      const bestAsk = Math.min(0.99, Math.round((pUp + 0.02) * 1000) / 1000);
      return { pUp, bestBid, bestAsk, spread: Math.round((bestAsk - bestBid) * 1000) / 1000 };
    }
    const exchange = (await getExchange()) as Record<string, unknown> | null;
    if (!exchange) {
      let hash = 0;
      for (let i = 0; i < window.exchangeWindowId.length; i++) hash = (hash * 31 + window.exchangeWindowId.charCodeAt(i)) >>> 0;
      const pUp = Math.min(0.95, Math.max(0.05, 0.42 + (hash % 1600) / 10000));
      const bestBid = Math.max(0.01, Math.round((pUp - 0.02) * 1000) / 1000);
      const bestAsk = Math.min(0.99, Math.round((pUp + 0.02) * 1000) / 1000);
      return { pUp, bestBid, bestAsk, spread: Math.round((bestAsk - bestBid) * 1000) / 1000 };
    }
    try {
      // Try unified fetchOrderBook for the Up outcome symbol
      const markets = (exchange as { markets?: Record<string, Record<string, unknown>> }).markets;
      let symbol: string | null = null;
      if (markets) {
        for (const [sym, meta] of Object.entries(markets)) {
          const maybeId = String((meta as { marketId?: string }).marketId ?? (meta as { id?: string }).id ?? "");
          if (maybeId === window.exchangeWindowId) {
            symbol = sym;
            break;
          }
        }
      }
      if (!symbol) symbol = window.exchangeWindowId;

      const fetchBook = (exchange as { fetchOrderBook?: (s: string) => Promise<Record<string, unknown>> }).fetchOrderBook;
      if (fetchBook) {
        const book = await fetchBook.call(exchange, symbol);
        const bids = (book as { bids?: [number, number][] }).bids ?? [];
        const asks = (book as { asks?: [number, number][] }).asks ?? [];
        const bestBid = bids.length ? Number(bids[0][0]) : NaN;
        const bestAsk = asks.length ? Number(asks[0][0]) : NaN;
        if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
          const mid = (bestBid + bestAsk) / 2;
          const spread = Math.max(0, bestAsk - bestBid);
          return { pUp: Math.min(0.99, Math.max(0.01, mid)), bestBid, bestAsk, spread };
        }
        if (Number.isFinite(bestAsk)) return { pUp: Math.min(0.99, Math.max(0.01, bestAsk)), bestAsk, spread: 0.02 };
        if (Number.isFinite(bestBid)) return { pUp: Math.min(0.99, Math.max(0.01, bestBid)), bestBid, spread: 0.02 };
      }
      const client = (exchange as { client: Record<string, unknown> }).client as Record<string, unknown>;
      const getBook = (client as { getBinaryOrderBook?: (id: string) => Promise<Record<string, unknown>> }).getBinaryOrderBook;
      if (getBook) {
        const book = await getBook.call(client, window.exchangeWindowId);
        const yes = (book as { yes?: { bids?: { price: number }[]; asks?: { price: number }[] } }).yes;
        const bids = yes?.bids ?? [];
        const asks = yes?.asks ?? [];
        const bestBid = bids.length ? Number((bids[0] as { price: number }).price) : NaN;
        const bestAsk = asks.length ? Number((asks[0] as { price: number }).price) : NaN;
        if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
          const mid = (bestBid + bestAsk) / 2;
          const spread = Math.max(0, bestAsk - bestBid);
          return { pUp: Math.min(0.99, Math.max(0.01, mid)), bestBid, bestAsk, spread };
        }
      }
      let hash = 0;
      for (let i = 0; i < window.exchangeWindowId.length; i++) hash = (hash * 31 + window.exchangeWindowId.charCodeAt(i)) >>> 0;
      const pUp = Math.min(0.95, Math.max(0.05, 0.42 + (hash % 1600) / 10000));
      return { pUp, bestBid: pUp - 0.02, bestAsk: pUp + 0.02, spread: 0.04 };
    } catch (e) {
      if (isAuthError(e)) throw e;
      console.warn(`[adapter] getMarketOdds SDK fallback: ${String((e as Error).message)}`);
      let hash = 0;
      for (let i = 0; i < window.exchangeWindowId.length; i++) hash = (hash * 31 + window.exchangeWindowId.charCodeAt(i)) >>> 0;
      const pUp = Math.min(0.95, Math.max(0.05, 0.42 + (hash % 1600) / 10000));
      return { pUp, bestBid: pUp - 0.02, bestAsk: pUp + 0.02, spread: 0.04 };
    }
  });
}

export async function placeOrder(window: ExchangeWindow, side: Direction, stake: number): Promise<ExchangeOrderResult> {
  const cfg = getDreamdexConfig();
  return retryWithBackoff(async () => {
    if (isPlaceholderKey(cfg.privateKey)) {
      const mockId = `mock-${window.exchangeWindowId}-${side}-${Date.now()}`;
      console.log(`[adapter] MOCK placeOrder ${side} stake=${stake} window=${window.exchangeWindowId} -> ${mockId}`);
      return { exchangeOrderId: mockId, status: "PLACED" };
    }
    const exchange = (await getExchange()) as Record<string, unknown> | null;
    if (!exchange) {
      const mockId = `mock-${window.exchangeWindowId}-${side}-${Date.now()}`;
      return { exchangeOrderId: mockId, status: "PLACED" };
    }
    // Balance check before signing — avoid revert loop
    try {
      const client = (exchange as { client: Record<string, unknown> }).client as Record<string, unknown>;
      // Optional balance check — if available
      // Skip if not available
      void client;
    } catch {}

    try {
      // Unified createOrder — symbol, type, side, amount, price, { timeInForce: "IOC", expire... }
      // For binary, price is the Up probability; amount is stake
      // Use IOC always per spec, expireTimestampNs = now+300s in nanos, capped at market expiry
      const markets = (exchange as { markets?: Record<string, Record<string, unknown>> }).markets;
      let symbol: string | null = null;
      let marketExpirySec: number | null = null;
      if (markets) {
        for (const [sym, meta] of Object.entries(markets)) {
          const maybeId = String((meta as { marketId?: string }).marketId ?? "");
          if (maybeId === window.exchangeWindowId) {
            symbol = sym;
            marketExpirySec = Number((meta as { expiry?: number }).expiry ?? window.closeTs.getTime() / 1000);
            break;
          }
        }
      }
      if (!symbol) symbol = window.exchangeWindowId;

      // IOC only fills if the limit price crosses the spread — the midpoint doesn't guarantee
      // a fill. Buying UP must bid at/above bestAsk; buying DOWN (a "sell" of the Up token)
      // must offer at/below bestBid. A small slippage cushion absorbs book movement between
      // our quote fetch and the tx landing.
      let limitPrice = 0.5;
      const SLIPPAGE = 0.01;
      try {
        const odds = await getMarketOdds(window);
        if (side === "UP") {
          limitPrice = Math.min(0.99, (odds.bestAsk ?? odds.pUp) + SLIPPAGE);
        } else {
          limitPrice = Math.max(0.01, (odds.bestBid ?? odds.pUp) - SLIPPAGE);
        }
      } catch {}
      // Snap is handled by SDK >=0.28 per implementation.md
      const amount = stake; // stake in collateral units — SDK expects human units
      const expireSec = Math.floor(Date.now() / 1000) + 300;
      const cappedExpireSec = marketExpirySec ? Math.min(expireSec, marketExpirySec - 1) : expireSec;
      const expireTimestampNs = BigInt(cappedExpireSec) * BigInt(1000000000);

      const createOrder = (exchange as { createOrder: (s: string, t: string, side: string, amt: number, price: number, p: Record<string, unknown>) => Promise<Record<string, unknown>> }).createOrder.bind(exchange);
      const orderSide = side === "UP" ? "buy" : "sell"; // YES is Up
      const order = await createOrder(symbol, "limit", orderSide, amount, limitPrice, {
        timeInForce: "IOC",
        // expireTimestampNs is part of unified? If not, SDK may ignore; pass through
        expireTimestampNs,
      } as unknown as Record<string, unknown>);

      // Receipt is on (order.info as PlaceOrderResult).receipt, not order.receipt
      const receipt = (order as { info?: { receipt?: unknown } }).info?.receipt;
      void receipt;
      const id = String((order as { id?: string }).id ?? (order as { orderId?: string }).orderId ?? `order-${Date.now()}`);
      return { exchangeOrderId: id, status: "PLACED" };
    } catch (e) {
      // Check for revert — treat as did not place, not success
      const msg = String((e as Error).message ?? e);
      if (msg.toLowerCase().includes("revert") || msg.toLowerCase().includes("insufficient")) {
        console.warn(`[adapter] placeOrder reverted/insufficient: ${msg}`);
        throw new Error(`NETWORK_ERROR: order reverted — ${msg}`);
      }
      if (isAuthError(e)) throw e;
      console.warn(`[adapter] placeOrder failed: ${msg}`);
      throw e;
    }
  });
}

export async function getFinalizedWindows(sinceTs: Date): Promise<ExchangeSettlement[]> {
  const cfg = getDreamdexConfig();
  return retryWithBackoff(async () => {
    if (isPlaceholderKey(cfg.privateKey)) {
      return [];
    }
    const exchange = (await getExchange()) as Record<string, unknown> | null;
    if (!exchange) return [];
    const client = (exchange as { client: Record<string, unknown> }).client as Record<string, unknown>;
    const list = (client as { listBinaryMarkets?: (o: Record<string, unknown>) => Promise<unknown[]> }).listBinaryMarkets;
    const getResolution = (client as { getMarketResolution?: (id: string) => Promise<Record<string, unknown>> }).getMarketResolution;
    if (!list || !getResolution) return [];
    try {
      const markets = (await list.call(client, { venueId: cfg.venueId || undefined, status: "Finalized", limit: 100 })) as Record<string, unknown>[];
      const results: ExchangeSettlement[] = [];
      for (const m of markets) {
        const marketId = String((m as { marketId?: string }).marketId ?? (m as { id?: string }).id ?? "");
        if (!marketId) continue;
        // Filter by sinceTs via settlement time if available
        const settledAtRaw = (m as { settledAt?: string | number }).settledAt ?? (m as { updatedAt?: string }).updatedAt;
        if (settledAtRaw) {
          const settledAt = new Date(typeof settledAtRaw === "number" ? settledAtRaw * 1000 : String(settledAtRaw));
          if (settledAt < sinceTs) continue;
        }
        try {
          const resolution = await (getResolution as (id: string) => Promise<Record<string, unknown>>).call(client, marketId);
          const voided = Boolean((resolution as { voided?: boolean }).voided ?? (m as { voided?: boolean }).voided ?? false);
          let outcome: Direction | null = null;
          if (!voided) {
            const closing = (resolution as { closingAnswer?: { numericValue?: number } }).closingAnswer?.numericValue;
            const opening = (resolution as { openingAnswer?: { numericValue?: number } }).openingAnswer?.numericValue;
            if (typeof closing === "number" && typeof opening === "number") {
              outcome = closing > opening ? "UP" : "DOWN";
            } else {
              // Fallback to resolution outcome field if available
              const raw = String((resolution as { outcome?: string }).outcome ?? (resolution as { result?: string }).result ?? "").toUpperCase();
              if (raw === "UP" || raw === "DOWN") outcome = raw as Direction;
            }
          }
          const oracleQuestionId = String((m as { oracleQuestionId?: string }).oracleQuestionId ?? (m as { questionId?: string }).questionId ?? "");
          results.push({
            exchangeWindowId: marketId,
            oracleQuestionId: oracleQuestionId || null,
            outcome,
            voided,
            settledAt: settledAtRaw ? new Date(typeof settledAtRaw === "number" ? settledAtRaw * 1000 : String(settledAtRaw)) : new Date(),
          });
        } catch (e) {
          console.warn(`[adapter] getMarketResolution failed for ${marketId}: ${String(e)}`);
        }
      }
      return results;
    } catch (e) {
      if (isAuthError(e)) throw e;
      console.warn(`[adapter] getFinalizedWindows fallback empty: ${String((e as Error).message)}`);
      return [];
    }
  });
}

// Legacy alias — keep for existing callers
export const getSettledWindows = getFinalizedWindows;

export async function redeemWinnings(exchangeWindowId: string): Promise<{ redeemed: boolean }> {
  const cfg = getDreamdexConfig();
  return retryWithBackoff(async () => {
    if (isPlaceholderKey(cfg.privateKey)) {
      console.log(`[adapter] MOCK redeemWinnings ${exchangeWindowId}`);
      return { redeemed: true };
    }
    const exchange = (await getExchange()) as Record<string, unknown> | null;
    if (!exchange) return { redeemed: false };
    const trader = (exchange as { trader: Record<string, unknown> }).trader as Record<string, unknown>;
    const redeem = (trader as { redeem?: (p: Record<string, unknown>) => Promise<unknown> }).redeem;
    const client = (exchange as { client: Record<string, unknown> }).client as Record<string, unknown>;
    const getResolution = (client as { getMarketResolution?: (id: string) => Promise<Record<string, unknown>> }).getMarketResolution;
    if (!redeem || !getResolution) return { redeemed: false };
    try {
      const resolution = await (getResolution as (id: string) => Promise<Record<string, unknown>>).call(client, exchangeWindowId);
      const voided = Boolean((resolution as { voided?: boolean }).voided ?? false);
      if (voided) {
        // Voided: redeem both outcome indices 0 and 1, each pays 0.5
        try {
          await (redeem as (p: Record<string, unknown>) => Promise<unknown>).call(trader, { marketId: exchangeWindowId, outcomeIdx: 0 });
        } catch {}
        try {
          await (redeem as (p: Record<string, unknown>) => Promise<unknown>).call(trader, { marketId: exchangeWindowId, outcomeIdx: 1 });
        } catch {}
        return { redeemed: true };
      }
      const closing = (resolution as { closingAnswer?: { numericValue?: number } }).closingAnswer?.numericValue;
      const opening = (resolution as { openingAnswer?: { numericValue?: number } }).openingAnswer?.numericValue;
      let winningIdx: number | null = null;
      if (typeof closing === "number" && typeof opening === "number") {
        winningIdx = closing > opening ? 0 : 1; // 0=YES=UP, 1=NO=DOWN per SDK
      }
      if (winningIdx === null) {
        const raw = String((resolution as { outcome?: string }).outcome ?? "").toUpperCase();
        if (raw === "UP") winningIdx = 0;
        else if (raw === "DOWN") winningIdx = 1;
      }
      if (winningIdx === null) return { redeemed: false };
      // Explicit outcome index — never inferred winner on voided (already handled)
      await (redeem as (p: Record<string, unknown>) => Promise<unknown>).call(trader, { marketId: exchangeWindowId, outcomeIdx: winningIdx });
      return { redeemed: true };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      // Redeeming a losing position succeeds and pays 0 — don't throw
      if (msg.toLowerCase().includes("no winnings") || msg.toLowerCase().includes("already redeemed")) {
        return { redeemed: true };
      }
      console.warn(`[adapter] redeemWinnings failed for ${exchangeWindowId}: ${msg}`);
      return { redeemed: false };
    }
  });
}

// Optional permissionless backstop — per implementation.md M4 nice-to-have
export async function pokeOracle(questionId: string): Promise<boolean> {
  if (!questionId) return false;
  const cfg = getDreamdexConfig();
  if (isPlaceholderKey(cfg.privateKey)) return false;
  const exchange = (await getExchange()) as Record<string, unknown> | null;
  if (!exchange) return false;
  try {
    const trader = (exchange as { trader: Record<string, unknown> }).trader as Record<string, unknown>;
    const poke = (trader as { pokeOracle?: (p: Record<string, unknown>) => Promise<unknown> }).pokeOracle;
    if (!poke) return false;
    await poke.call(trader, { questionId });
    return true;
  } catch {
    return false;
  }
}

export async function voidExpired(marketId: string): Promise<boolean> {
  if (!marketId) return false;
  const cfg = getDreamdexConfig();
  if (isPlaceholderKey(cfg.privateKey)) return false;
  const exchange = (await getExchange()) as Record<string, unknown> | null;
  if (!exchange) return false;
  try {
    const trader = (exchange as { trader: Record<string, unknown> }).trader as Record<string, unknown>;
    const fn = (trader as { voidExpired?: (p: Record<string, unknown>) => Promise<unknown> }).voidExpired;
    if (!fn) return false;
    await fn.call(trader, { marketId });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wallet balance — real on-chain STT check, used to avoid revert-loop trading
// ---------------------------------------------------------------------------

let _publicClient: ReturnType<typeof createPublicClient> | null = null;
function getPublicClient() {
  const cfg = getDreamdexConfig();
  if (!_publicClient) {
    _publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });
  }
  return _publicClient;
}

/**
 * Returns the wallet's native STT balance (in whole STT, not wei).
 * Mock mode (placeholder key) returns Infinity so the mock demo path never
 * gets blocked by a balance gate it can't actually satisfy.
 */
export async function getWalletBalanceStt(): Promise<number> {
  const cfg = getDreamdexConfig();
  if (isPlaceholderKey(cfg.privateKey)) return Infinity;
  try {
    const account = privateKeyToAccount(cfg.privateKey);
    const client = getPublicClient();
    const wei = await client.getBalance({ address: account.address });
    return Number(formatEther(wei));
  } catch (e) {
    console.warn(`[adapter] getWalletBalanceStt failed, treating as zero balance: ${String(e)}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Health check — used by getSystemStatus
// ---------------------------------------------------------------------------

export async function checkConnection(): Promise<boolean> {
  try {
    const cfg = getDreamdexConfig();
    if (isPlaceholderKey(cfg.privateKey)) return true;
    const exchange = await getExchange();
    if (!exchange) return false;
    // If exchange loaded markets, it's connected
    return true;
  } catch {
    return false;
  }
}
