"use client";

import { useEffect, useState, useCallback } from "react";
import MarketViewCard, { MarketViewData } from "./components/MarketViewCard";
import ReliabilityChart, { ReliabilityData, EconomicBucket, BenchmarkComparison } from "./components/ReliabilityChart";
import DecisionLog, { DecisionRow } from "./components/DecisionLog";
import SignalSandbox from "./components/SignalSandbox";

type MarketViewResponse = MarketViewData;
type TrackRecordResponse = ReliabilityData & {
  decisions: DecisionRow[];
  economicRealization?: EconomicBucket[];
  benchmarkScores?: BenchmarkComparison;
};

export default function Page() {
  const [marketView, setMarketView] = useState<MarketViewData | null>(null);
  const [track, setTrack] = useState<TrackRecordResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [lastGood, setLastGood] = useState<{ mv: MarketViewData | null; tr: TrackRecordResponse | null }>({ mv: null, tr: null });

  const fetchAll = useCallback(async () => {
    try {
      const [mvRes, trRes] = await Promise.all([
        fetch("/api/market-view", { cache: "no-store" }),
        fetch("/api/track-record", { cache: "no-store" }),
      ]);
      if (!mvRes.ok || !trRes.ok) throw new Error(`fetch failed ${mvRes.status} ${trRes.status}`);
      const mv = (await mvRes.json()) as MarketViewResponse;
      const tr = (await trRes.json()) as TrackRecordResponse;
      setMarketView(mv);
      setTrack(tr);
      setLastGood({ mv, tr });
      setStale(false);
    } catch (e) {
      console.warn("fetch failed, showing last known good + stale indicator", e);
      if (lastGood.mv) setMarketView(lastGood.mv);
      if (lastGood.tr) setTrack(lastGood.tr);
      setStale(true);
    }
  }, [lastGood.mv, lastGood.tr]);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 25000);
    return () => clearInterval(id);
  }, [fetchAll]);

  // Also poll ingest-visible countdown locally every second for smoothness (derive from window closeTs)
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // nowTick is used implicitly via MarketViewCard countdown which reads Date.now()

  return (
    <main className="mx-auto max-w-[720px] px-4 py-6 flex flex-col gap-5">
      {/* Header */}
      <header className="nb-card" style={{ background: "var(--nb-ink)", color: "var(--nb-bg)" }}>
        <h1 className="text-2xl sm:text-3xl leading-none" style={{ color: "var(--nb-bg)" }}>
          DRIMER
        </h1>
        <p className="text-sm mt-1 font-black uppercase tracking-widest" style={{ color: "var(--nb-accent)" }}>
          The Calibration Layer
        </p>
        <p className="text-sm mt-2 font-medium" style={{ color: "var(--nb-bg)", opacity: 0.85 }}>
          Self-calibrating probability for DreamDEX Event Contracts · Every prediction logged, whether or not we trade.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="nb-border px-2 py-1 bg-white text-black font-bold">SOMNIA × DREAMDEX</span>
          <span className="nb-border px-2 py-1 bg-[var(--nb-accent)] text-black font-bold">SHANNON TESTNET</span>
          <span className="nb-border px-2 py-1 bg-white text-black">MCP-NATIVE · AGENTIC L1</span>
        </div>
      </header>

      {/* Hero band — makes the deployed URL work as DoraHacks landing page (design.md:80) */}
      <section className="nb-card" style={{ background: "var(--nb-bg)" }}>
        <h2 className="text-xl sm:text-2xl leading-none">WE PUT REAL STAKE ON REAL CALIBRATION.</h2>
        <p className="text-sm mt-2 font-medium" style={{ textTransform: "none", letterSpacing: "normal" }}>
          A live agent trading DreamDEX Event Contracts with its own testnet capital. It only bets when its track record backs the edge, and any other agent can ask it why, over MCP.
        </p>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="nb-border p-2 bg-[var(--nb-caution)]">
            <p className="font-black uppercase text-xs">WATCH</p>
            <p className="text-[11px] mt-1">Every prediction logged, traded or not</p>
          </div>
          <div className="nb-border p-2 bg-[var(--nb-accent)]">
            <p className="font-black uppercase text-xs">TRADE</p>
            <p className="text-[11px] mt-1">Real stake, only on a real edge</p>
          </div>
          <div className="nb-border p-2 bg-white">
            <p className="font-black uppercase text-xs">ASK</p>
            <p className="text-[11px] mt-1">Query it live over MCP</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 text-[11px] tabular-nums">
          <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="nb-border px-2 py-1 bg-white font-bold underline">
            GitHub
          </a>
          <span className="nb-border px-2 py-1 bg-white">MCP: POST /mcp</span>
          <span className="nb-border px-2 py-1 bg-white">SSE: GET /sse</span>
          <span className="nb-border px-2 py-1 bg-white opacity-70">Demo video coming soon</span>
        </div>
      </section>

      {/* Signal Sandbox — interactive simulator + MCP call generator, first thing after the pitch */}
      <SignalSandbox />

      {/* Hero — Market View */}
      <MarketViewCard data={marketView} stale={stale} key={nowTick} />

      {/* Reliability */}
      <ReliabilityChart
        data={
          track
            ? {
                buckets: track.buckets,
                brierScore: track.brierScore,
                totalPredictions: track.totalPredictions,
                totalSettled: track.totalSettled,
                modelVersion: track.modelVersion,
                economicRealization: track.economicRealization,
                benchmarkScores: track.benchmarkScores,
              }
            : null
        }
      />

      {/* Decision Log */}
      <DecisionLog rows={track?.decisions ?? null} />

      {/* System status footer */}
      <footer className="nb-card">
        <h3 className="text-sm">SYSTEM STATUS</h3>
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs tabular-nums">
          <div className="nb-border p-2 bg-white">
            <p className="font-black uppercase text-[10px]">Exchange</p>
            <p className="font-bold">{track ? "CONNECTED" : "—"}</p>
          </div>
          <div className="nb-border p-2 bg-white">
            <p className="font-black uppercase text-[10px]">Last Settlement</p>
            <p className="font-bold truncate">{track?.totalSettled ? `${track.totalSettled} total` : "NONE YET"}</p>
          </div>
          <div className="nb-border p-2 bg-white">
            <p className="font-black uppercase text-[10px]">Model</p>
            <p className="font-bold truncate">{track?.modelVersion ?? marketView?.modelVersion ?? "—"}</p>
          </div>
          <div className="nb-border p-2" style={{ background: marketView?.riskLimits?.killSwitch ? "var(--nb-danger)" : "white" }}>
            <p className="font-black uppercase text-[10px]">Kill Switch</p>
            <p className="font-bold">{marketView?.riskLimits?.killSwitch ? "ACTIVE" : "OFF"}</p>
          </div>
        </div>
        <p className="text-[11px] mt-3 opacity-60">
          Polling every 25s. Last fetch: {marketView?.asOf ? new Date(marketView.asOf).toLocaleTimeString() : "—"} {stale && "· STALE, showing last known good"}
        </p>
        <p className="text-[11px] mt-1 opacity-60">
          API: <code className="nb-border px-1 bg-white">GET /api/market-view</code> <code className="nb-border px-1 bg-white">GET /api/track-record</code> <code className="nb-border px-1 bg-white">GET /api/system-status</code> · MCP: <code className="nb-border px-1 bg-white">POST /mcp</code>
        </p>
      </footer>

      <p className="text-center text-[11px] uppercase tracking-widest" style={{ color: "var(--nb-ink)" }}>&copy; 2026 Drimer</p>
    </main>
  );
}
