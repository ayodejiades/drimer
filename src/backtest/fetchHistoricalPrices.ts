import "dotenv/config";
/**
 * Fetch 60-90 days of BTC/ETH price history from a free public API.
 * No paid key required. Tries CoinGecko first, falls back to synthetic.
 */

export type PricePoint = { ts: Date; price: number; asset: "BTC" | "ETH" };

async function fetchCoinGecko(asset: "BTC" | "ETH", days = 90): Promise<PricePoint[]> {
  const id = asset === "BTC" ? "bitcoin" : "ethereum";
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=hourly`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { prices: [number, number][] };
  return json.prices.map(([ts, price]) => ({ ts: new Date(ts), price, asset }));
}

function syntheticPrices(asset: "BTC" | "ETH", days = 90, intervalMin = 15): PricePoint[] {
  // Deterministic random walk — used only if real API fails, and labeled BACKTEST anyway
  const points: PricePoint[] = [];
  const start = Date.now() - days * 24 * 60 * 60 * 1000;
  const step = intervalMin * 60 * 1000;
  const n = Math.floor((days * 24 * 60) / intervalMin);
  let price = asset === "BTC" ? 65000 : 3200;
  let seed = asset === "BTC" ? 42 : 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < n; i++) {
    const ts = new Date(start + i * step);
    // Gaussian-like daily vol ~2% for BTC, 3% for ETH, scaled to 15min
    const vol15m = asset === "BTC" ? 0.002 : 0.003;
    const ret = (rand() - 0.5) * vol15m * 2 + (rand() - 0.5) * vol15m;
    price = price * (1 + ret);
    price = Math.max(price, 100);
    points.push({ ts, price: Math.round(price * 100) / 100, asset });
  }
  return points;
}

export async function fetchHistoricalPrices(asset: "BTC" | "ETH", days = 90): Promise<PricePoint[]> {
  try {
    console.log(`[backtest] fetching ${asset} ${days}d from CoinGecko...`);
    const pts = await fetchCoinGecko(asset, days);
    console.log(`[backtest] got ${pts.length} points for ${asset}`);
    return pts;
  } catch (e) {
    console.warn(`[backtest] CoinGecko failed for ${asset}: ${String(e)} — using synthetic walk`);
    return syntheticPrices(asset, days);
  }
}

if (require.main === module) {
  (async () => {
    const btc = await fetchHistoricalPrices("BTC", 7);
    const eth = await fetchHistoricalPrices("ETH", 7);
    console.log(`BTC ${btc.length} pts:`, btc.slice(0, 2));
    console.log(`ETH ${eth.length} pts:`, eth.slice(0, 2));
  })();
}
