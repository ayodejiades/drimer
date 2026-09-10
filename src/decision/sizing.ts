type RiskLimitsLike = {
  maxStakePerTrade: number;
  maxDailyStake: number;
  minEdgeThreshold: number;
};

export type SizingResult = {
  stake: number;
  kellyFraction: number;
};

/**
 * Fractional Kelly sizing, hard-capped at maxStakePerTrade.
 * edge is modelPUp - marketPUp, marketPUp used as implied odds.
 * Uses quarter-Kelly (0.25) as default conservatism.
 *
 * Pure function — no I/O.
 */
export function sizePosition(
  edge: number,
  riskLimits: RiskLimitsLike,
  opts?: { kellyFraction?: number; bankroll?: number }
): SizingResult {
  const kellyFractionMult = opts?.kellyFraction ?? 0.25;
  const bankroll = opts?.bankroll ?? 100; // notional bankroll for Kelly math; cap still applies

  const absEdge = Math.abs(edge);
  if (absEdge < 1e-9) return { stake: 0, kellyFraction: 0 };

  // Simplified Kelly for binary even-odds: f* = edge / odds? For prediction market,
  // Kelly fraction ~ edge / (marketPUp * (1 - marketPUp)) is aggressive.
  // We use: rawKelly = edge / 0.5 approx scaled, then quarter.
  // More accurate: if market odds imply return, Kelly for binary at even odds:
  // f* = (p * b - q) / b where b = payout odds. With b≈1 (even), f*≈ 2p-1.
  // edge = p_model - p_market; if market is fair, p_market≈0.5, so f*≈2*edge.
  // Use: raw = 2*edge, fractional = raw * kellyFractionMult * bankroll? Keep bounded.
  // Instead: stake = min( |edge| * bankroll * kellyFractionMult * 2, maxStakePerTrade )

  // Raw Kelly-inspired stake: 2 * |edge| * bankroll * fraction
  const rawStake = 2 * absEdge * bankroll * kellyFractionMult;
  const capped = Math.min(rawStake, riskLimits.maxStakePerTrade);
  // Never exceed maxStakePerTrade, never negative
  const stake = Math.max(0, capped);
  // Reported kellyFraction is rawStake / bankroll (for observability)
  const kellyFraction = rawStake / bankroll;

  return { stake: Math.round(stake * 100) / 100, kellyFraction: Math.round(kellyFraction * 10000) / 10000 };
}

export function wouldExceedDailyLimit(currentDailyTotal: number, newStake: number, riskLimits: RiskLimitsLike): boolean {
  return currentDailyTotal + newStake > riskLimits.maxDailyStake;
}
