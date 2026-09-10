import type { Asset, Duration, Direction } from "@prisma/client";

export type ExchangeWindow = {
  exchangeWindowId: string; // SDK marketId (bytes32)
  oracleQuestionId?: string | null;
  asset: Asset;
  duration: Duration;
  openTs: Date;
  closeTs: Date;
};

export type MarketOdds = {
  pUp: number; // 0..1, mid of best bid/ask for Up outcome
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
};

export type ExchangeOrderResult = {
  exchangeOrderId: string;
  status: string;
};

export type ExchangeSettlement = {
  exchangeWindowId: string;
  oracleQuestionId?: string | null;
  outcome: Direction | null; // null when voided
  voided: boolean;
  settledAt?: Date;
};

export type AdapterError =
  | { kind: "AUTH_ERROR"; message: string }
  | { kind: "NETWORK_ERROR"; message: string; cause?: unknown }
  | { kind: "NOT_FOUND"; message: string }
  | { kind: "RATE_LIMITED"; message: string }
  | { kind: "UNKNOWN"; message: string; cause?: unknown };

export function isAuthError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const msg = String((e as { message?: unknown }).message ?? e).toLowerCase();
  return msg.includes("auth") || msg.includes("unauthorized") || msg.includes("session") || msg.includes("forbidden") || msg.includes("revert");
}
