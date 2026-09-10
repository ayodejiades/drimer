"use client";

type Reason =
  | "EDGE_CLEARED"
  | "EDGE_BELOW_THRESHOLD"
  | "INSUFFICIENT_DATA"
  | "RISK_LIMIT_HIT"
  | "KILL_SWITCH_ACTIVE"
  | "PREDICTION_EXISTS"
  | "EXCESSIVE_SPREAD"
  | "LOW_VOLATILITY_CHOP"
  | "INSUFFICIENT_GAS";

const MAP: Record<string, { bg: string; label: string }> = {
  EDGE_CLEARED: { bg: "var(--nb-accent)", label: "EDGE CLEARED" },
  EDGE_BELOW_THRESHOLD: { bg: "var(--nb-caution)", label: "WATCHING" },
  INSUFFICIENT_DATA: { bg: "var(--nb-caution)", label: "GATHERING DATA" },
  RISK_LIMIT_HIT: { bg: "var(--nb-danger)", label: "RISK LIMIT" },
  KILL_SWITCH_ACTIVE: { bg: "var(--nb-danger)", label: "KILL SWITCH" },
  PREDICTION_EXISTS: { bg: "#E5E5E5", label: "ALREADY LOGGED" },
  EXCESSIVE_SPREAD: { bg: "var(--nb-danger)", label: "EXCESSIVE SPREAD" },
  LOW_VOLATILITY_CHOP: { bg: "var(--nb-caution)", label: "LOW VOL CHOP" },
  INSUFFICIENT_GAS: { bg: "var(--nb-danger)", label: "INSUFFICIENT GAS" },
};

export default function StatusBadge({ reason }: { reason: string }) {
  const entry = MAP[reason] ?? { bg: "#E5E5E5", label: reason };
  return (
    <span className="nb-badge" style={{ background: entry.bg, color: "#000" }}>
      {entry.label}
    </span>
  );
}
