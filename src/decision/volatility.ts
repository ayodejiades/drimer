/**
 * Volatility chop filter — pure function, no I/O.
 * Adopts Somnia-DreamDEX-Agent's strength (avoid trading dead-flat markets)
 * without needing a full OHLC feed: a market sitting within a hair of 50/50
 * with a tight spread is showing no directional conviction, so we sit out
 * rather than pay the spread for a coinflip.
 */

export const CHOP_DEVIATION_THRESHOLD = 0.015; // market pUp within 1.5pp of 50/50
export const CHOP_MAX_SPREAD_FOR_FLAT = 0.03; // tight spread — genuinely quiet, not just illiquid

export type ChopInputs = {
  marketPUp: number;
  spread: number;
};

export function isLowVolatilityChop(inputs: ChopInputs): boolean {
  const deviation = Math.abs(inputs.marketPUp - 0.5);
  return deviation < CHOP_DEVIATION_THRESHOLD && inputs.spread <= CHOP_MAX_SPREAD_FOR_FLAT;
}
