/**
 * Centralized edge computation — both orchestrator and MCP must use this
 * identical function. Never compute modelPUp - marketPUp inline elsewhere.
 */
export function computeEdge(modelPUp: number, marketPUp: number): number {
  return modelPUp - marketPUp;
}

export function computeAbsEdge(modelPUp: number, marketPUp: number): number {
  return Math.abs(computeEdge(modelPUp, marketPUp));
}

export type ExecutableEdgeResult = {
  rawEdge: number;
  executableEdge: number;
  direction: "UP" | "DOWN" | "NEUTRAL";
  spread: number;
  isExecutable: boolean;
};

/**
 * Computes edge against real executable quotes (bestAsk when buying UP, bestBid when buying DOWN).
 * Neutralizes slippage and punishes wide testnet bid/ask spreads.
 */
export function computeExecutableEdge(
  modelPUp: number,
  bestBid: number,
  bestAsk: number,
  maxAllowedSpread = 0.15
): ExecutableEdgeResult {
  const midpoint = (bestBid + bestAsk) / 2;
  const rawEdge = modelPUp - midpoint;
  const spread = Math.max(0, bestAsk - bestBid);

  // If we believe UP: we buy at bestAsk
  // Executable edge is (what we think it's worth) - (what we must pay)
  const edgeUp = modelPUp - bestAsk;

  // If we believe DOWN: we buy DOWN contracts at (1 - bestBid)
  // Our probability of DOWN is (1 - modelPUp)
  // Executable edge is (1 - modelPUp) - (1 - bestBid) = bestBid - modelPUp
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

  const isExecutable = spread <= maxAllowedSpread && executableEdge > 0;

  return {
    rawEdge,
    executableEdge,
    direction,
    spread,
    isExecutable,
  };
}

