-- CreateEnum
CREATE TYPE "TraderStatus" AS ENUM ('INITIALIZING', 'ACTIVE', 'PAUSED', 'COMPLETING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "TraderMode" AS ENUM ('LIVE', 'SIMULATION');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP_LIMIT', 'TAKE_PROFIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PositionSide" AS ENUM ('LONG', 'SHORT', 'BOTH');

-- CreateEnum
CREATE TYPE "HedgeRole" AS ENUM ('SHORT', 'HEDGE');

-- CreateTable
CREATE TABLE "Trader" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "mode" "TraderMode" NOT NULL,
    "status" "TraderStatus" NOT NULL DEFAULT 'INITIALIZING',
    "leverage" INTEGER NOT NULL,
    "marginMode" TEXT NOT NULL,
    "initialCapital" TEXT NOT NULL,
    "positionSize" TEXT NOT NULL,
    "shortEntryPrice" TEXT,
    "shortTpPrice" TEXT,
    "currentHedgeLevel" INTEGER NOT NULL DEFAULT 0,
    "hedgeEntryPrice" TEXT,
    "hedgeTpPrice" TEXT,
    "hedgeStopPrice" TEXT,
    "realizedPnl" TEXT NOT NULL DEFAULT '0',
    "unrealizedPnl" TEXT NOT NULL DEFAULT '0',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "traderId" TEXT NOT NULL,
    "exchangeOrderId" TEXT,
    "clientOrderId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "role" "HedgeRole" NOT NULL,
    "hedgeLevel" INTEGER NOT NULL DEFAULT 0,
    "quantity" TEXT NOT NULL,
    "price" TEXT,
    "stopPrice" TEXT,
    "filledQuantity" TEXT NOT NULL DEFAULT '0',
    "avgFillPrice" TEXT,
    "fee" TEXT NOT NULL DEFAULT '0',
    "feeCurrency" TEXT,
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "filledAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "traderId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "PositionSide" NOT NULL,
    "role" "HedgeRole" NOT NULL,
    "hedgeLevel" INTEGER NOT NULL DEFAULT 0,
    "entryPrice" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "leverage" INTEGER NOT NULL,
    "unrealizedPnl" TEXT NOT NULL DEFAULT '0',
    "realizedPnl" TEXT NOT NULL DEFAULT '0',
    "liquidationPrice" TEXT,
    "markPrice" TEXT,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "traderId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "role" "HedgeRole" NOT NULL,
    "hedgeLevel" INTEGER NOT NULL DEFAULT 0,
    "quantity" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "fee" TEXT NOT NULL,
    "feeCurrency" TEXT NOT NULL,
    "realizedPnl" TEXT NOT NULL DEFAULT '0',
    "tradeTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraderStatistics" (
    "id" TEXT NOT NULL,
    "traderId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "mode" "TraderMode" NOT NULL,
    "shortEntryPrice" TEXT NOT NULL,
    "shortExitPrice" TEXT,
    "totalHedgeLevels" INTEGER NOT NULL DEFAULT 0,
    "hedgeWins" INTEGER NOT NULL DEFAULT 0,
    "hedgeLosses" INTEGER NOT NULL DEFAULT 0,
    "totalFees" TEXT NOT NULL DEFAULT '0',
    "realizedPnl" TEXT NOT NULL DEFAULT '0',
    "peakUnrealizedPnl" TEXT NOT NULL DEFAULT '0',
    "durationMs" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TraderStatistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalStatistics" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "totalTraders" INTEGER NOT NULL DEFAULT 0,
    "activeTraders" INTEGER NOT NULL DEFAULT 0,
    "completedTraders" INTEGER NOT NULL DEFAULT 0,
    "totalRealizedPnl" TEXT NOT NULL DEFAULT '0',
    "totalFees" TEXT NOT NULL DEFAULT '0',
    "dailyPnl" TEXT NOT NULL DEFAULT '0',
    "winRate" TEXT NOT NULL DEFAULT '0',
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalStatistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Configuration" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "maxTraders" INTEGER NOT NULL DEFAULT 5,
    "initialCapital" TEXT NOT NULL DEFAULT '1000',
    "positionSize" TEXT NOT NULL DEFAULT '100',
    "leverage" INTEGER NOT NULL DEFAULT 10,
    "marginMode" TEXT NOT NULL DEFAULT 'ISOLATED',
    "hedgeDistance" TEXT NOT NULL DEFAULT '0.10',
    "hedgeTpPercent" TEXT NOT NULL DEFAULT '0.50',
    "hedgeSlPercent" TEXT NOT NULL DEFAULT '0.10',
    "shortTpPercent" TEXT NOT NULL DEFAULT '0.20',
    "refreshInterval" INTEGER NOT NULL DEFAULT 60000,
    "retryLimit" INTEGER NOT NULL DEFAULT 5,
    "feeRate" TEXT NOT NULL DEFAULT '0.0004',
    "slippage" TEXT NOT NULL DEFAULT '0.0001',
    "mode" "TraderMode" NOT NULL DEFAULT 'SIMULATION',
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppLog" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" TEXT,
    "meta" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Trader_symbol_idx" ON "Trader"("symbol");

-- CreateIndex
CREATE INDEX "Trader_status_idx" ON "Trader"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_exchangeOrderId_key" ON "Order"("exchangeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_clientOrderId_key" ON "Order"("clientOrderId");

-- CreateIndex
CREATE INDEX "Order_traderId_idx" ON "Order"("traderId");

-- CreateIndex
CREATE INDEX "Order_symbol_idx" ON "Order"("symbol");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_clientOrderId_idx" ON "Order"("clientOrderId");

-- CreateIndex
CREATE INDEX "Position_traderId_idx" ON "Position"("traderId");

-- CreateIndex
CREATE INDEX "Position_symbol_idx" ON "Position"("symbol");

-- CreateIndex
CREATE INDEX "Position_isOpen_idx" ON "Position"("isOpen");

-- CreateIndex
CREATE INDEX "Trade_traderId_idx" ON "Trade"("traderId");

-- CreateIndex
CREATE INDEX "Trade_symbol_idx" ON "Trade"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "TraderStatistics_traderId_key" ON "TraderStatistics"("traderId");

-- CreateIndex
CREATE INDEX "AppLog_level_idx" ON "AppLog"("level");

-- CreateIndex
CREATE INDEX "AppLog_timestamp_idx" ON "AppLog"("timestamp");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_traderId_fkey" FOREIGN KEY ("traderId") REFERENCES "Trader"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_traderId_fkey" FOREIGN KEY ("traderId") REFERENCES "Trader"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_traderId_fkey" FOREIGN KEY ("traderId") REFERENCES "Trader"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraderStatistics" ADD CONSTRAINT "TraderStatistics_traderId_fkey" FOREIGN KEY ("traderId") REFERENCES "Trader"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
