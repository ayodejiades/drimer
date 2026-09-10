"use client";

import StatusBadge from "./StatusBadge";

export type MarketViewData = {
  window: { exchangeWindowId: string; oracleQuestionId?: string | null; oracleAuditUrl?: string | null; asset: string; duration: string; openTs: string; closeTs: string; source?: string } | null;
  modelPUp: number | null;
  marketPUp: number | null;
  edge: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  nObservations: number;
  modelVersion: string | null;
  riskLimits: { maxStakePerTrade: number; maxDailyStake: number; minEdgeThreshold: number; killSwitch: boolean } | null;
  wouldTradeNow: boolean;
  reason: string;
  asOf: string;
};

function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function countdown(closeTs: string | undefined): string {
  if (!closeTs) return "—";
  const diff = new Date(closeTs).getTime() - Date.now();
  if (diff <= 0) return "SETTLING…";
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function MarketViewCard({ data, stale }: { data: MarketViewData | null; stale?: boolean }) {
  if (!data) {
    return (
      <div className="nb-card">
        <div className="nb-skeleton w-full h-24" />
        <p className="mt-3 text-sm font-bold uppercase">Loading market view…</p>
      </div>
    );
  }

  const isEmpty = data.modelPUp === null;
  if (isEmpty) {
    return (
      <div className="nb-card">
        <h2 className="text-xl">MARKET VIEW · {data.window?.asset ?? "ETH"} / {data.window?.duration ?? "15-MIN"}</h2>
        <div className="mt-4 p-4 nb-border bg-[var(--nb-caution)]">
          <p className="font-black uppercase text-sm">GATHERING DATA · {data.nObservations} OBSERVATIONS LOGGED</p>
          <p className="text-sm mt-1">Need {20 - data.nObservations} more settled windows before trading. Keep the bot running.</p>
          <p className="text-xs mt-2 tabular-nums">MODEL {data.modelVersion ?? "—"} · AS OF {new Date(data.asOf).toLocaleString()}</p>
        </div>
        {data.window && (
          <p className="text-xs mt-3 tabular-nums break-all">
            WINDOW {data.window.exchangeWindowId.slice(0, 18)}… · CLOSES IN {countdown(data.window.closeTs)} · SOURCE {data.window.source ?? "LIVE"}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="nb-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl leading-none">
            MARKET VIEW · {data.window?.asset ?? "ETH"} / {(data.window?.duration ?? "FIFTEEN_MIN").replace("_", " ")}
          </h2>
          <p className="text-xs mt-1 tabular-nums break-all">
            WINDOW {data.window?.exchangeWindowId ? `${data.window.exchangeWindowId.slice(0, 18)}…` : "—"} · CLOSES IN {countdown(data.window?.closeTs)} {stale && <span className="ml-2 px-1 nb-border bg-[var(--nb-danger)] text-white text-[10px]">STALE</span>}
          </p>
          {data.window?.oracleQuestionId && (
            <p className="text-xs mt-1">
              <a href={`https://prd.oracle.somnia.host/questions/${data.window.oracleQuestionId}?view=graph`} target="_blank" rel="noopener noreferrer" className="underline font-bold uppercase">
                verify on oracle
              </a>
              <span className="opacity-60"> · price sources & median for this window</span>
            </p>
          )}
        </div>
        <StatusBadge reason={data.reason} />
      </div>

      {/* Stats row — switches to column below 640px */}
      <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="nb-border p-3 bg-white">
          <p className="text-[11px] font-black uppercase tracking-widest">Model P(UP)</p>
          <p className="text-2xl font-black tabular-nums mt-1">{fmtPct(data.modelPUp)}</p>
          <p className="text-[11px] tabular-nums">90% CI {fmtPct(data.confidenceLow)} – {fmtPct(data.confidenceHigh)}</p>
        </div>
        <div className="nb-border p-3 bg-white">
          <p className="text-[11px] font-black uppercase tracking-widest">Market P(UP)</p>
          <p className="text-2xl font-black tabular-nums mt-1">{fmtPct(data.marketPUp)}</p>
          <p className="text-[11px] tabular-nums">ON-CHAIN ODDS</p>
        </div>
        <div className="nb-border p-3" style={{ background: data.wouldTradeNow ? "var(--nb-accent)" : "var(--nb-caution)" }}>
          <p className="text-[11px] font-black uppercase tracking-widest">Edge</p>
          <p className="text-2xl font-black tabular-nums mt-1">{data.edge !== null ? `${(data.edge * 100).toFixed(2)}pp` : "—"}</p>
          <p className="text-[11px] font-bold uppercase">{data.wouldTradeNow ? "CLEARS THRESHOLD" : "BELOW THRESHOLD"}</p>
        </div>
        <div className="nb-border p-3 bg-white">
          <p className="text-[11px] font-black uppercase tracking-widest">Would Trade Now?</p>
          <p className="text-lg font-black uppercase mt-1">{data.wouldTradeNow ? "YES" : "NO"}</p>
          <p className="text-[11px] tabular-nums">THRESH {data.riskLimits ? `${(data.riskLimits.minEdgeThreshold * 100).toFixed(0)}pp` : "—"} · N={data.nObservations}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-xs tabular-nums">
        <span className="nb-border px-2 py-1 bg-white">MODEL {data.modelVersion}</span>
        <span className="nb-border px-2 py-1 bg-white">N={data.nObservations} OBS</span>
        <span className="nb-border px-2 py-1 bg-white">KILL SWITCH {data.riskLimits?.killSwitch ? "ACTIVE" : "OFF"}</span>
        <span className="nb-border px-2 py-1 bg-white">AS OF {new Date(data.asOf).toLocaleTimeString()}</span>
      </div>

      <p className="text-[11px] mt-3 opacity-70">Every probability is named: MODEL_P_UP vs MARKET_P_UP. EDGE is the named difference. Provenance on every payload.</p>
    </div>
  );
}
