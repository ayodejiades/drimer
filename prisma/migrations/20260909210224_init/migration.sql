-- CreateEnum
CREATE TYPE "Asset" AS ENUM ('BTC', 'ETH');

-- CreateEnum
CREATE TYPE "Duration" AS ENUM ('FIFTEEN_MIN', 'ONE_HOUR');

-- CreateEnum
CREATE TYPE "WindowStatus" AS ENUM ('OPEN', 'LOCKED', 'SETTLED', 'VOIDED', 'MISSED');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('LIVE', 'BACKTEST');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('UP', 'DOWN');

-- CreateEnum
CREATE TYPE "DecisionAction" AS ENUM ('TRADE', 'SKIP');

-- CreateEnum
CREATE TYPE "DecisionReason" AS ENUM ('EDGE_CLEARED', 'EDGE_BELOW_THRESHOLD', 'INSUFFICIENT_DATA', 'RISK_LIMIT_HIT', 'KILL_SWITCH_ACTIVE', 'EXCESSIVE_SPREAD', 'LOW_VOLATILITY_CHOP', 'INSUFFICIENT_GAS');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PLACED', 'FINALIZED_WIN', 'FINALIZED_LOSS', 'FAILED');

-- CreateTable
CREATE TABLE "Window" (
    "id" TEXT NOT NULL,
    "asset" "Asset" NOT NULL,
    "duration" "Duration" NOT NULL,
    "openTs" TIMESTAMP(3) NOT NULL,
    "closeTs" TIMESTAMP(3) NOT NULL,
    "exchangeWindowId" TEXT NOT NULL,
    "oracleQuestionId" TEXT,
    "status" "WindowStatus" NOT NULL DEFAULT 'OPEN',
    "source" "DataSource" NOT NULL DEFAULT 'LIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Window_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "modelPUp" DOUBLE PRECISION NOT NULL,
    "marketPUp" DOUBLE PRECISION NOT NULL,
    "edge" DOUBLE PRECISION NOT NULL,
    "confidenceLow" DOUBLE PRECISION NOT NULL,
    "confidenceHigh" DOUBLE PRECISION NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "nObservations" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "action" "DecisionAction" NOT NULL,
    "reason" "DecisionReason" NOT NULL,
    "stake" DOUBLE PRECISION,
    "kellyFraction" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "exchangeOrderId" TEXT NOT NULL,
    "side" "Direction" NOT NULL,
    "stake" DOUBLE PRECISION NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PLACED',
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemed" BOOLEAN NOT NULL DEFAULT false,
    "redeemedAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "outcome" "Direction",
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskLimits" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "maxStakePerTrade" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "maxDailyStake" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "minEdgeThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskLimits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Window_exchangeWindowId_key" ON "Window"("exchangeWindowId");

-- CreateIndex
CREATE INDEX "Window_asset_duration_openTs_idx" ON "Window"("asset", "duration", "openTs");

-- CreateIndex
CREATE INDEX "Window_status_idx" ON "Window"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Prediction_windowId_key" ON "Prediction"("windowId");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_predictionId_key" ON "Decision"("predictionId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_decisionId_key" ON "Order"("decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_exchangeOrderId_key" ON "Order"("exchangeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_windowId_key" ON "Settlement"("windowId");

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "Window"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "Window"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
