"use client";

export type Bucket = {
  binLow: number;
  binHigh: number;
  binCenter: number;
  n: number;
  avgPredicted: number | null;
  observedFreq: number | null;
  source: "LIVE" | "BACKTEST" | "MIXED";
};

export type EconomicBucket = {
  edgeRange: string;
  tradeCount: number;
  winRate: number;
  realizedRoi: number;
};

export type BenchmarkComparison = {
  drimerBrierScore: number;
  marketImpliedBrierScore: number;
  naiveMomentumBrierScore: number;
  drimerAdvantagePercent: number;
};

export type ReliabilityData = {
  buckets: Bucket[];
  brierScore: number | null;
  totalPredictions: number;
  totalSettled: number;
  modelVersion: string | null;
  economicRealization?: EconomicBucket[];
  benchmarkScores?: BenchmarkComparison;
};

function EconomicRealizationPanel({ data }: { data: ReliabilityData }) {
  const buckets = data.economicRealization ?? [];
  const bench = data.benchmarkScores;
  if (buckets.length === 0 && !bench) return null;

  return (
    <div className="mt-4 pt-4" style={{ borderTop: "3px solid var(--nb-ink)" }}>
      <h4 className="text-sm">ECONOMIC REALIZATION · DOES CALIBRATION PAY?</h4>
      <p className="text-[11px] mt-1 opacity-70">Does calibration translate into positive returns? Here&apos;s Drimer&apos;s realized ROI, segmented by how big the edge was when we traded it.</p>

      {buckets.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs tabular-nums border-collapse" style={{ minWidth: 480 }}>
            <thead>
              <tr>
                <th className="nb-border p-2 bg-[var(--nb-ink)] text-white uppercase text-[11px] text-left">Edge Bucket</th>
                <th className="nb-border p-2 bg-[var(--nb-ink)] text-white uppercase text-[11px]">Trades</th>
                <th className="nb-border p-2 bg-[var(--nb-ink)] text-white uppercase text-[11px]">Win Rate</th>
                <th className="nb-border p-2 bg-[var(--nb-ink)] text-white uppercase text-[11px]">Realized ROI</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.edgeRange} className="bg-white">
                  <td className="nb-border p-2 font-bold">{b.edgeRange}</td>
                  <td className="nb-border p-2 text-center">{b.tradeCount}</td>
                  <td className="nb-border p-2 text-center">{b.tradeCount > 0 ? `${(b.winRate * 100).toFixed(0)}%` : "—"}</td>
                  <td
                    className="nb-border p-2 text-center font-bold"
                    style={{ background: b.tradeCount > 0 ? (b.realizedRoi >= 0 ? "var(--nb-accent)" : "var(--nb-danger)") : undefined }}
                  >
                    {b.tradeCount > 0 ? `${b.realizedRoi >= 0 ? "+" : ""}${b.realizedRoi.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {bench && (
        <div className="mt-3 flex flex-wrap gap-2 text-[11px] tabular-nums">
          <span className="nb-badge" style={{ background: "var(--nb-accent)" }}>DRIMER BRIER {bench.drimerBrierScore.toFixed(3)}</span>
          <span className="nb-badge" style={{ background: "white" }}>MARKET IMPLIED {bench.marketImpliedBrierScore.toFixed(3)}</span>
          <span className="nb-badge" style={{ background: "white" }}>MOMENTUM BOT {bench.naiveMomentumBrierScore.toFixed(3)}</span>
          <span className="nb-badge" style={{ background: "var(--nb-ink)", color: "white" }}>
            {bench.drimerAdvantagePercent >= 0 ? "+" : ""}{bench.drimerAdvantagePercent.toFixed(1)}% BETTER THAN MARKET
          </span>
        </div>
      )}
    </div>
  );
}

export default function ReliabilityChart({ data }: { data: ReliabilityData | null }) {
  if (!data || data.totalSettled === 0) {
    return (
      <div className="nb-card">
        <h3 className="text-lg">RELIABILITY DIAGRAM</h3>
        <div className="mt-3 p-6 nb-border bg-white text-center">
          <p className="font-black uppercase">GATHERING DATA · 0 SETTLEMENTS LOGGED</p>
          <p className="text-sm mt-2">Predictions are being written every window. The chart appears after the first settlement.</p>
          <p className="text-xs mt-3 tabular-nums">MODEL {data?.modelVersion ?? "—"} · PREDICTIONS {data?.totalPredictions ?? 0}</p>
        </div>
        <p className="text-xs mt-2 opacity-60">X: predicted P(UP) · Y: observed frequency of UP · Diagonal = perfect calibration</p>
        {data && <EconomicRealizationPanel data={data} />}
      </div>
    );
  }

  // SVG dims — hand-rolled per design.md: 3px axes, squares sized by n, dashed diagonal
  const W = 520;
  const H = 360;
  const padL = 44;
  const padR = 14;
  const padB = 36;
  const padT = 14;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xScale = (v: number) => padL + v * plotW;
  const yScale = (v: number) => padT + (1 - v) * plotH;

  const maxN = Math.max(...data.buckets.map((b) => b.n), 1);

  return (
    <div className="nb-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg">RELIABILITY DIAGRAM</h3>
        <span className="text-xs tabular-nums nb-border px-2 py-1 bg-white">
          BRIER {data.brierScore !== null ? data.brierScore.toFixed(4) : "—"} · N={data.totalSettled} SETTLED
        </span>
      </div>

      <div className="mt-3 nb-border bg-white p-2 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="auto" style={{ display: "block", maxWidth: 560 }} role="img" aria-label="Reliability diagram">
          {/* Grid — light */}
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line x1={xScale(v)} y1={padT} x2={xScale(v)} y2={padT + plotH} stroke="#E5E5E5" strokeWidth={1} />
              <line x1={padL} y1={yScale(v)} x2={padL + plotW} y2={yScale(v)} stroke="#E5E5E5" strokeWidth={1} />
            </g>
          ))}
          {/* Axes — 3px solid black */}
          <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="var(--nb-ink)" strokeWidth={3} />
          <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="var(--nb-ink)" strokeWidth={3} />
          {/* Diagonal reference — dashed 3px */}
          <line x1={xScale(0)} y1={yScale(0)} x2={xScale(1)} y2={yScale(1)} stroke="var(--nb-ink)" strokeWidth={3} strokeDasharray="8 6" />

          {/* Buckets */}
          {data.buckets.map((b, i) => {
            if (b.avgPredicted === null || b.observedFreq === null || b.n === 0) return null;
            const cx = xScale(b.avgPredicted);
            const cy = yScale(b.observedFreq);
            // Size by n: 8..18
            const size = 8 + (b.n / maxN) * 10;
            const isBacktest = b.source === "BACKTEST";
            return (
              <g key={i}>
                <rect
                  x={cx - size / 2}
                  y={cy - size / 2}
                  width={size}
                  height={size}
                  fill={isBacktest ? "none" : "var(--nb-ink)"}
                  stroke="var(--nb-ink)"
                  strokeWidth={3}
                />
                {/* n label */}
                <text x={cx} y={cy - size / 2 - 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="var(--nb-ink)">
                  {b.n}
                </text>
              </g>
            );
          })}

          {/* Axis labels */}
          {[0, 0.5, 1].map((v) => (
            <g key={`x-${v}`}>
              <text x={xScale(v)} y={padT + plotH + 14} textAnchor="middle" fontSize={10} fontWeight={700}>
                {v.toFixed(1)}
              </text>
            </g>
          ))}
          {[0, 0.5, 1].map((v) => (
            <g key={`y-${v}`}>
              <text x={padL - 6} y={yScale(v) + 3} textAnchor="end" fontSize={10} fontWeight={700}>
                {v.toFixed(1)}
              </text>
            </g>
          ))}
          <text x={padL + plotW / 2} y={H - 4} textAnchor="middle" fontSize={10} fontWeight={800} letterSpacing="0.06em">
            PREDICTED P(UP)
          </text>
          <text transform={`translate(10 ${padT + plotH / 2}) rotate(-90)`} textAnchor="middle" fontSize={10} fontWeight={800} letterSpacing="0.06em">
            OBSERVED FREQ
          </text>
        </svg>
      </div>

      <div className="mt-2 flex flex-wrap gap-2 text-[11px] tabular-nums">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 nb-border" style={{ background: "var(--nb-ink)" }} /> LIVE
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 nb-border bg-white" /> BACKTEST
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-5 h-[3px]" style={{ background: "var(--nb-ink)", backgroundImage: "repeating-linear-gradient(90deg, var(--nb-ink) 0 8px, transparent 8px 14px)" }} /> PERFECT CALIBRATION
        </span>
        <span className="ml-auto">MODEL {data.modelVersion ?? "—"}</span>
      </div>
      <p className="text-[11px] mt-2 opacity-60">Filled squares = live data. Outlined squares = backtest (forward-walk, no lookahead). Size = N in bucket. Dashed diagonal = reference, not data.</p>
      <EconomicRealizationPanel data={data} />
    </div>
  );
}
