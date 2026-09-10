"use client";

import { useState } from "react";
import StatusBadge from "./StatusBadge";

const DEFAULT_VISIBLE = 8;

export type DecisionRow = {
  id: string;
  createdAt: string;
  asset: string;
  duration: string;
  modelPUp: number;
  marketPUp: number;
  edge: number;
  action: string;
  reason: string;
  stake: number | null;
  outcome: string | null;
  voided?: boolean | null;
  source: string;
  exchangeWindowId: string;
  oracleQuestionId?: string | null;
};

export default function DecisionLog({ rows }: { rows: DecisionRow[] | null }) {
  const [showAll, setShowAll] = useState(false);

  if (!rows || rows.length === 0) {
    return (
      <div className="nb-card">
        <h3 className="text-lg">DECISION LOG · LAST 50</h3>
        <div className="mt-3 nb-border p-4 bg-white">
          <p className="font-bold uppercase text-sm">No decisions yet. The orchestrator hasn’t ticked.</p>
          <p className="text-sm mt-1">Run <code className="nb-border px-1 bg-[#E5E5E5]">tsx src/orchestrator/runTick.ts</code> to log the first prediction.</p>
        </div>
      </div>
    );
  }

  const visibleRows = showAll ? rows : rows.slice(0, DEFAULT_VISIBLE);

  return (
    <div className="nb-card">
      <h3 className="text-lg">
        DECISION LOG · {showAll ? `ALL ${rows.length}` : `LAST ${visibleRows.length} OF ${rows.length}`}
      </h3>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs tabular-nums border-collapse" style={{ minWidth: 640 }}>
          <thead>
            <tr className="text-left">
              <th className="nb-border p-2 bg-[var(--nb-ink)] text-white uppercase text-[11px]">Time</th>
              <th className="nb-border p-2 bg-[var(--nb-ink)] text-white uppercase text-[11px]">Window</th>
              <th className="nb-border p-2 bg-[var(--nb-ink)] text-white uppercase text-[11px]">Model / Market</th>
              <th className="nb-border p-2 bg-[var(--nb-ink)] text-white uppercase text-[11px]">Edge</th>
              <th className="nb-border p-2 bg-[var(--nb-ink)] text-white uppercase text-[11px]">Decision</th>
              <th className="nb-border p-2 bg-[var(--nb-ink)] text-white uppercase text-[11px]">Settlement</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr key={r.id} className="bg-white">
                <td className="nb-border p-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="nb-border p-2 whitespace-nowrap">
                  <span className="font-bold">{r.asset}</span> {r.duration.replace("_", " ")}
                  <br />
                  <span className="text-[10px] opacity-70">{r.exchangeWindowId.slice(0, 24)}…</span>
                  {r.source === "BACKTEST" && <span className="ml-1 nb-border px-1 text-[9px] bg-white">BACKTEST</span>}
                </td>
                <td className="nb-border p-2 whitespace-nowrap">
                  {(r.modelPUp * 100).toFixed(1)}% / {(r.marketPUp * 100).toFixed(1)}%
                </td>
                <td className="nb-border p-2 font-bold">{(r.edge * 100).toFixed(2)}pp</td>
                <td className="nb-border p-2">
                  <div className="flex flex-col gap-1">
                    <StatusBadge reason={r.reason} />
                    {r.stake !== null && <span className="text-[11px]">STAKE {r.stake}</span>}
                  </div>
                </td>
                <td className="nb-border p-2">
                  {r.voided ? (
                    <span className="nb-badge" style={{ background: "var(--nb-caution)", color: "#000" }}>
                      VOIDED
                    </span>
                  ) : r.outcome ? (
                    <span className="nb-badge" style={{ background: r.outcome === "UP" ? "var(--nb-accent)" : "var(--nb-ink)", color: r.outcome === "UP" ? "#000" : "#fff" }}>
                      {r.outcome}
                    </span>
                  ) : (
                    <span className="text-[11px] opacity-60">PENDING</span>
                  )}
                  {r.oracleQuestionId && (
                    <div className="mt-1">
                      <a
                        href={`https://prd.oracle.somnia.host/questions/${r.oracleQuestionId}?view=graph`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] underline font-bold uppercase"
                      >
                        verify
                      </a>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > DEFAULT_VISIBLE && (
        <button type="button" className="nb-button text-xs mt-3" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "SHOW LESS" : `SHOW ALL ${rows.length}`}
        </button>
      )}
    </div>
  );
}
