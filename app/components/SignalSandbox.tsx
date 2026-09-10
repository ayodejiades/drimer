"use client";

import { useMemo, useState } from "react";
import StatusBadge from "./StatusBadge";

// Mirrors src/decision/calibrate.ts + edge.ts + sizing.ts + volatility.ts exactly,
// but self-contained (normal-approx quantiles, no jstat) so it can run client-side
// in the browser without pulling a Node-only dependency into the bundle.
const MAX_STAKE_PER_TRADE = 5;
const MIN_EDGE_THRESHOLD = 0.05;
const MAX_ALLOWED_SPREAD = 0.15;
const CHOP_DEVIATION_THRESHOLD = 0.015;
const CHOP_MAX_SPREAD_FOR_FLAT = 0.03;

type SandboxResult = {
  modelPUp: number;
  confidenceLow: number;
  confidenceHigh: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  rawEdge: number;
  executableEdge: number;
  direction: "UP" | "DOWN" | "NEUTRAL";
  status: "EDGE_CLEARED" | "EDGE_BELOW_THRESHOLD" | "EXCESSIVE_SPREAD" | "LOW_VOLATILITY_CHOP";
  stake: number;
  kellyFraction: number;
};

function computeSandbox(marketPUp: number, driftBps: number, spreadPct: number): SandboxResult {
  const drift = driftBps / 10000;
  const SENSITIVITY = 2000;
  const MAX_EVIDENCE = 12;
  const evidence = Math.min(MAX_EVIDENCE, Math.abs(drift) * SENSITIVITY);
  const driftDeltaAlpha = drift > 0 ? evidence : 0;
  const driftDeltaBeta = drift < 0 ? evidence : 0;

  const alpha = 1 + driftDeltaAlpha;
  const beta = 1 + driftDeltaBeta;
  const EPS = 1e-6;
  let modelPUp = alpha / (alpha + beta);
  modelPUp = Math.min(1 - EPS, Math.max(EPS, modelPUp));

  const variance = (alpha * beta) / ((alpha + beta) * (alpha + beta) * (alpha + beta + 1));
  const sd = Math.sqrt(variance);
  const z = 1.6448536269514729; // 90% CI
  const confidenceLow = Math.min(1 - EPS, Math.max(EPS, modelPUp - z * sd));
  const confidenceHigh = Math.min(1 - EPS, Math.max(EPS, modelPUp + z * sd));

  const spread = spreadPct / 100;
  const bestBid = Math.max(0.01, marketPUp - spread / 2);
  const bestAsk = Math.min(0.99, marketPUp + spread / 2);
  const rawEdge = modelPUp - marketPUp;

  const edgeUp = modelPUp - bestAsk;
  const edgeDown = bestBid - modelPUp;
  let direction: "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";
  let executableEdge = 0;
  if (edgeUp > 0 && edgeUp >= edgeDown) {
    direction = "UP";
    executableEdge = edgeUp;
  } else if (edgeDown > 0 && edgeDown > edgeUp) {
    direction = "DOWN";
    executableEdge = edgeDown;
  }

  const isChop = Math.abs(marketPUp - 0.5) < CHOP_DEVIATION_THRESHOLD && spread <= CHOP_MAX_SPREAD_FOR_FLAT;

  let status: SandboxResult["status"];
  if (spread > MAX_ALLOWED_SPREAD) status = "EXCESSIVE_SPREAD";
  else if (isChop) status = "LOW_VOLATILITY_CHOP";
  else if (executableEdge <= 0 || Math.abs(rawEdge) < MIN_EDGE_THRESHOLD) status = "EDGE_BELOW_THRESHOLD";
  else status = "EDGE_CLEARED";

  const kellyFractionMult = 0.25;
  const bankroll = 100;
  const rawStake = 2 * Math.abs(rawEdge) * bankroll * kellyFractionMult;
  const stake = status === "EDGE_CLEARED" ? Math.round(Math.min(rawStake, MAX_STAKE_PER_TRADE) * 100) / 100 : 0;
  const kellyFraction = Math.round((rawStake / bankroll) * 10000) / 10000;

  return { modelPUp, confidenceLow, confidenceHigh, bestBid, bestAsk, spread, rawEdge, executableEdge, direction, status, stake, kellyFraction };
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export default function SignalSandbox() {
  const [asset, setAsset] = useState<"ETH" | "BTC">("ETH");
  const [marketPUp, setMarketPUp] = useState(0.5);
  const [driftBps, setDriftBps] = useState(0);
  const [spreadPct, setSpreadPct] = useState(4);
  const [copied, setCopied] = useState(false);

  const result = useMemo(() => computeSandbox(marketPUp, driftBps, spreadPct), [marketPUp, driftBps, spreadPct]);

  const mcpHost = process.env.NEXT_PUBLIC_MCP_URL ?? "http://localhost:3001/mcp";
  const curlCommand = `curl -s -X POST ${mcpHost} \\\n  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"audit_and_calibrate_signal","arguments":{"asset":"${asset}","rawProbabilityUp":${result.modelPUp.toFixed(3)},"intendedStake":${result.stake || MAX_STAKE_PER_TRADE}}}}'`;

  async function copyMcpCall() {
    try {
      await navigator.clipboard.writeText(curlCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard unavailable — no-op, button label just won't confirm
    }
  }

  return (
    <div className="nb-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg">SIGNAL SANDBOX</h3>
        <div className="flex gap-1">
          {(["ETH", "BTC"] as const).map((a) => (
            <button
              key={a}
              className="nb-badge"
              style={{ background: asset === a ? "var(--nb-ink)" : "white", color: asset === a ? "white" : "#000", cursor: "pointer" }}
              onClick={() => setAsset(a)}
              type="button"
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] mt-1 opacity-70">Drag the market odds, spot drift and spread to see the calibrated posterior, executable edge, and Kelly stake react live: the exact math the orchestrator runs on every tick.</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="text-[11px] font-black uppercase tracking-widest">Market Odds P(UP) · {fmtPct(marketPUp)}</span>
          <input
            type="range"
            min={0.1}
            max={0.9}
            step={0.01}
            value={marketPUp}
            onChange={(e) => setMarketPUp(Number(e.target.value))}
            className="w-full mt-2"
            data-demo="sandbox-market-odds"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-black uppercase tracking-widest">Spot Drift · {driftBps > 0 ? "+" : ""}{driftBps}bps</span>
          <input
            type="range"
            min={-50}
            max={50}
            step={1}
            value={driftBps}
            onChange={(e) => setDriftBps(Number(e.target.value))}
            className="w-full mt-2"
            data-demo="sandbox-spot-drift"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-black uppercase tracking-widest">Bid/Ask Spread · {spreadPct.toFixed(0)}%</span>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={spreadPct}
            onChange={(e) => setSpreadPct(Number(e.target.value))}
            className="w-full mt-2"
            data-demo="sandbox-spread"
          />
        </label>
      </div>

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="nb-border p-3 bg-white">
          <p className="text-[11px] font-black uppercase tracking-widest">Calibrated P(UP)</p>
          <p className="text-2xl font-black tabular-nums mt-1">{fmtPct(result.modelPUp)}</p>
          <p className="text-[11px] tabular-nums">90% CI {fmtPct(result.confidenceLow)} – {fmtPct(result.confidenceHigh)}</p>
        </div>
        <div className="nb-border p-3 bg-white">
          <p className="text-[11px] font-black uppercase tracking-widest">Executable Edge</p>
          <p className="text-2xl font-black tabular-nums mt-1">{result.executableEdge > 0 ? `${(result.executableEdge * 100).toFixed(2)}pp` : "—"}</p>
          <p className="text-[11px] tabular-nums">{result.direction} · BID {result.bestBid.toFixed(2)} / ASK {result.bestAsk.toFixed(2)}</p>
        </div>
        <div className="nb-border p-3" style={{ background: result.status === "EDGE_CLEARED" ? "var(--nb-accent)" : "white" }}>
          <p className="text-[11px] font-black uppercase tracking-widest">Kelly Stake</p>
          <p className="text-2xl font-black tabular-nums mt-1">{result.stake > 0 ? `${result.stake} USDso` : "—"}</p>
          <p className="text-[11px] tabular-nums">FRACTION {result.kellyFraction} · CAP {MAX_STAKE_PER_TRADE}</p>
        </div>
        <div className="nb-border p-3 bg-white flex flex-col justify-center items-start gap-1">
          <p className="text-[11px] font-black uppercase tracking-widest">Decision</p>
          <StatusBadge reason={result.status} />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className="nb-button text-xs" onClick={copyMcpCall} data-demo="sandbox-copy-mcp-call">
          {copied ? "COPIED!" : "COPY MCP TOOL CALL"}
        </button>
        <span className="text-[11px] opacity-60">audit_and_calibrate_signal via {mcpHost}</span>
      </div>
    </div>
  );
}
