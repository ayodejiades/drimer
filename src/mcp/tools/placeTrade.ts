import { z } from "zod";
import { evaluateAndAct } from "../../orchestrator/evaluateAndAct";

export const name = "place_trade";
export const description =
  "Place a real trade on the current Event Contract window — ONLY call this if get_market_view shows an edge that clears the threshold (EDGE_CLEARED). This is the sole side-effecting tool. It reuses the same idempotent orchestrator path as the scheduled tick, so calling twice for the same window is a safe no-op (not a double trade). Requires MCP_SHARED_SECRET bearer auth when deployed; read-only tools are open. Optional overrideStake caps stake.";

export const inputSchema = z.object({
  asset: z.enum(["BTC", "ETH"]).describe("Asset to trade — must have EDGE_CLEARED in get_market_view"),
  duration: z.enum(["FIFTEEN_MIN", "ONE_HOUR"]).optional().default("FIFTEEN_MIN"),
  overrideStake: z.number().positive().optional().describe("Override stake (capped by maxStakePerTrade anyway)"),
});

export async function handler(input: z.infer<typeof inputSchema>) {
  try {
    const asset = input.asset as "BTC" | "ETH";
    const duration = (input.duration ?? "FIFTEEN_MIN") as "FIFTEEN_MIN" | "ONE_HOUR";
    const result = await evaluateAndAct(asset, duration);

    // If overrideStake requested and trade fired, note it (actual sizing still via RiskLimits cap)
    if (input.overrideStake !== undefined && result.acted) {
      return {
        ...result,
        note: `overrideStake=${input.overrideStake} requested; actual stake governed by RiskLimits.maxStakePerTrade and fractional Kelly.`,
        asOf: new Date().toISOString(),
      };
    }

    return {
      ...result,
      asOf: new Date().toISOString(),
    };
  } catch (e) {
    return {
      error: String(e),
      asOf: new Date().toISOString(),
    };
  }
}
